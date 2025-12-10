import {
    BufferGeometry,
    FileLoader,
    Float32BufferAttribute,
    Loader,
    Color
} from 'three';

const _color = new Color();

class PLYLoader extends Loader {

    constructor(manager) {
        super(manager);
        this.propertyNameMapping = {};
        this.customPropertyMapping = {};
    }

    load(url, onLoad, onProgress, onError) {
        const scope = this;
        const loader = new FileLoader(this.manager);
        loader.setPath(this.path);
        loader.setResponseType('arraybuffer');
        loader.setRequestHeader(this.requestHeader);
        loader.setWithCredentials(this.withCredentials);

        loader.load(url, function (data) {
            try {
                onLoad(scope.parse(data));
            } catch (e) {
                if (onError) onError(e);
                else console.error(e);
                scope.manager.itemError(url);
            }
        }, onProgress, onError);
    }

    setPropertyNameMapping(mapping) {
        this.propertyNameMapping = mapping;
    }

    setCustomPropertyNameMapping(mapping) {
        this.customPropertyMapping = mapping;
    }

    // 自动识别 0-255 与 0-1 float 颜色
    normalizeColor(v) {
        if (v === undefined || v === null) return 0;
        return (v > 1.0) ? (v / 255.0) : v;
    }

    parse(data) {
        const scope = this;

        // ==========================
        //  extractHeaderText (缺失的函数)
        // ==========================
        function extractHeaderText(bytes) {
            let i = 0;
            let line = '';
            const lines = [];
            let cont = true;

            while (cont && i < bytes.length) {
                const c = String.fromCharCode(bytes[i++]);

                if (c !== '\n' && c !== '\r') {
                    line += c;
                } else {
                    if (line === 'end_header') cont = false;
                    if (line !== '') {
                        lines.push(line);
                        line = '';
                    }
                }
            }

            // 让 body 指向 header 之后的位置
            return { headerText: lines.join('\n') + '\n', headerLength: i };
        }

        function parseHeader(data, headerLength = 0) {
            const header = {
                comments: [],
                elements: [],
                headerLength: headerLength,
                objInfo: ''
            };

            const lines = data.split(/\r?\n/);
            let currentElement = null;

            function makeElementProp(values, mapping) {
                const prop = { type: values[0] };

                if (prop.type === 'list') {
                    prop.name = values[3];
                    prop.countType = values[1];
                    prop.itemType = values[2];
                } else {
                    prop.name = values[1];
                }

                if (prop.name in mapping) {
                    prop.name = mapping[prop.name];
                }
                return prop;
            }

            for (let line of lines) {
                line = line.trim();
                if (line === '') continue;

                const parts = line.split(/\s+/);
                const type = parts.shift();

                switch (type) {
                    case 'format':
                        header.format = parts[0];
                        header.version = parts[1];
                        break;

                    case 'comment':
                        header.comments.push(parts.join(' '));
                        break;

                    case 'element':
                        if (currentElement) header.elements.push(currentElement);
                        currentElement = {
                            name: parts[0],
                            count: parseInt(parts[1]),
                            properties: []
                        };
                        break;

                    case 'property':
                        currentElement.properties.push(makeElementProp(parts, scope.propertyNameMapping));
                        break;

                    case 'obj_info':
                        header.objInfo = parts.join(' ');
                        break;
                }
            }

            if (currentElement) header.elements.push(currentElement);
            return header;
        }

        function createBuffer() {
            const buf = {
                indices: [],
                vertices: [],
                normals: [],
                uvs: [],
                faceVertexUvs: [],
                colors: [],
                faceVertexColors: []
            };
            for (const key of Object.keys(scope.customPropertyMapping)) buf[key] = [];
            return buf;
        }

        function mapAttributes(props) {
            const names = props.map(p => p.name);
            function find(list) { return list.find(n => names.includes(n)) || null; }

            return {
                x: find(['x', 'px', 'posx']) || 'x',
                y: find(['y', 'py', 'posy']) || 'y',
                z: find(['z', 'pz', 'posz']) || 'z',

                nx: find(['nx', 'normalx']),
                ny: find(['ny', 'normaly']),
                nz: find(['nz', 'normalz']),

                s: find(['s', 'u', 'tex_u']),
                t: find(['t', 'v', 'tex_v']),

                r: find(['red', 'diffuse_red', 'r']),
                g: find(['green', 'diffuse_green', 'g']),
                b: find(['blue', 'diffuse_blue', 'b'])
            };
        }

        function handleElement(buffer, name, e, m) {
            if (name === 'vertex') {
                buffer.vertices.push(e[m.x], e[m.y], e[m.z]);

                if (m.nx && m.ny && m.nz)
                    buffer.normals.push(e[m.nx], e[m.ny], e[m.nz]);

                if (m.s && m.t)
                    buffer.uvs.push(e[m.s], e[m.t]);

                if (m.r && m.g && m.b) {
                    _color.setRGB(
                        scope.normalizeColor(e[m.r]),
                        scope.normalizeColor(e[m.g]),
                        scope.normalizeColor(e[m.b])
                    );
                    buffer.colors.push(_color.r, _color.g, _color.b);
                }
            }
        }

        function post(buffer) {
            const geo = new BufferGeometry();

            if (buffer.indices.length > 0)
                geo.setIndex(buffer.indices);

            geo.setAttribute('position', new Float32BufferAttribute(buffer.vertices, 3));

            if (buffer.normals.length)
                geo.setAttribute('normal', new Float32BufferAttribute(buffer.normals, 3));

            if (buffer.uvs.length)
                geo.setAttribute('uv', new Float32BufferAttribute(buffer.uvs, 2));

            if (buffer.colors.length)
                geo.setAttribute('color', new Float32BufferAttribute(buffer.colors, 3));

            geo.computeBoundingSphere();
            return geo;
        }
        function parseASCII(data, header) {
            const buffer = createBuffer();

            const bodyMatch = /end_header\s+([\s\S]*)$/i.exec(data);
            if (!bodyMatch) return post(buffer);

            const tokens = bodyMatch[1].trim().split(/\s+/);
            let idx = 0;

            function next() { return tokens[idx++]; }
            function readNumber(type) {
                if (['char','uchar','short','ushort','int','uint','int8','uint8','int16','uint16','int32','uint32']
                    .includes(type)) return parseInt(next());
                return parseFloat(next());
            }

            for (const elem of header.elements) {
                const attr = mapAttributes(elem.properties);

                for (let i=0; i<elem.count; i++) {
                    const e = {};
                    for (const p of elem.properties) {
                        if (p.type === 'list') {
                            const len = readNumber(p.countType);
                            const arr = [];
                            for (let k=0; k<len; k++) arr.push(readNumber(p.itemType));
                            e[p.name] = arr;
                        } else {
                            e[p.name] = readNumber(p.type);
                        }
                    }
                    handleElement(buffer, elem.name, e, attr);
                }
            }

            return post(buffer);
        }

        // 根据 PLY 数字类型返回对应的 DataView 读取器
        function getReader(type, dv, little) {
            switch (type) {
                case 'char': case 'int8':   return { size:1, read:(o)=>dv.getInt8(o) };
                case 'uchar': case 'uint8': return { size:1, read:(o)=>dv.getUint8(o) };
                case 'short': case 'int16': return { size:2, read:(o)=>dv.getInt16(o,little) };
                case 'ushort': case 'uint16': return { size:2, read:(o)=>dv.getUint16(o,little) };
                case 'int': case 'int32':   return { size:4, read:(o)=>dv.getInt32(o,little) };
                case 'uint': case 'uint32': return { size:4, read:(o)=>dv.getUint32(o,little) };
                case 'float': case 'float32': return { size:4, read:(o)=>dv.getFloat32(o,little) };
                case 'double': case 'float64': return { size:8, read:(o)=>dv.getFloat64(o,little) };
            }
        }

        function parseBinary(data, header) {
            const buffer = createBuffer();
            const little = (header.format === 'binary_little_endian');

            const bytes = new Uint8Array(data);
            const dv = new DataView(data, header.headerLength);

            let offset = 0;

            for (const elem of header.elements) {
                const props = elem.properties;
                const readers = props.map(p => {
                    if (p.type === 'list') {
                        return {
                            isList: true,
                            countReader: getReader(p.countType, dv, little),
                            itemReader: getReader(p.itemType, dv, little),
                            name: p.name
                        };
                    }
                    return {
                        isList: false,
                        reader: getReader(p.type, dv, little),
                        name: p.name
                    };
                });

                const attr = mapAttributes(props);

                for (let i=0; i<elem.count; i++) {
                    const e = {};

                    for (const r of readers) {
                        if (r.isList) {
                            const n = r.countReader.read(header.headerLength + offset);
                            offset += r.countReader.size;

                            const arr = [];
                            for (let k=0; k<n; k++) {
                                arr.push(r.itemReader.read(header.headerLength + offset));
                                offset += r.itemReader.size;
                            }
                            e[r.name] = arr;
                        } else {
                            e[r.name] = r.reader.read(header.headerLength + offset);
                            offset += r.reader.size;
                        }
                    }

                    handleElement(buffer, elem.name, e, attr);
                }
            }

            return post(buffer);
        }

        // ==========================
        // 主解析入口
        // ==========================
        let geometry;

        if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            const { headerText, headerLength } = extractHeaderText(bytes);
            const header = parseHeader(headerText, headerLength);

            if (header.format === 'ascii') {
                const text = new TextDecoder().decode(bytes);
                geometry = parseASCII(text, header);
            } else {
                geometry = parseBinary(data, header);
            }
        } else {
            // 纯文本（ASCII）
            geometry = parseASCII(data, parseHeader(data));
        }

        return geometry;
    }
}

export { PLYLoader };
