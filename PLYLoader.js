/**
 * Fully compatible PLYLoader for Three.js (ESM)
 * Supports ASCII + Binary, vertex colors, faces, uchar/int lists,
 * auto color normalization for uchar(0-255) & float(0-1).
 */

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
        const loader = new FileLoader(scope.manager);
        loader.setPath(scope.path);
        loader.setResponseType('arraybuffer');
        loader.load(url, function (data) {
            try {
                onLoad(scope.parse(data));
            } catch (e) {
                if (onError) onError(e);
                else console.error(e);
            }
        }, onProgress, onError);
    }

    // Mapping custom names (if needed)
    setPropertyNameMapping(mapping) { this.propertyNameMapping = mapping; }
    setCustomPropertyNameMapping(mapping) { this.customPropertyMapping = mapping; }

    // Auto adapt 0-255 or 0-1 float
    normalizeColor(v) {
        if (v == null) return 0;
        return (v > 1.0) ? v / 255.0 : v;
    }

    parse(data) {
        const scope = this;

        // ============================================================
        // extractHeaderText (binary header reader)
        // ============================================================
        function extractHeaderText(bytes) {
            let idx = 0;
            let line = "";
            const lines = [];
            let done = false;

            while (!done && idx < bytes.length) {
                const c = String.fromCharCode(bytes[idx++]);
                if (c !== '\n' && c !== '\r') line += c;
                else {
                    if (line === "end_header") {
                        lines.push(line);
                        done = true;
                    } else if (line !== '') {
                        lines.push(line);
                    }
                    line = "";
                }
            }
            return { headerText: lines.join("\n"), headerLength: idx };
        }

        // ============================================================
        // Parse header text → list elements/properties
        // ============================================================
        function parseHeader(text, headerLength = 0) {
            const header = {
                format: "",
                version: "",
                comments: [],
                elements: [],
                headerLength: headerLength
            };

            const lines = text.split(/\r?\n/);
            let current = null;

            function applyMapping(name) {
                return scope.propertyNameMapping[name] || name;
            }

            for (let line of lines) {
                line = line.trim();
                if (!line) continue;

                const parts = line.split(/\s+/);
                const type = parts.shift();

                switch (type) {
                    case "format":
                        header.format = parts[0];
                        header.version = parts[1];
                        break;

                    case "comment":
                        header.comments.push(parts.join(" "));
                        break;

                    case "element":
                        if (current) header.elements.push(current);
                        current = { name: parts[0], count: parseInt(parts[1]), properties: [] };
                        break;

                    case "property": {
                        const ptype = parts[0];
                        let prop = null;

                        if (ptype === 'list') {
                            prop = {
                                type: 'list',
                                countType: parts[1],
                                itemType: parts[2],
                                name: applyMapping(parts[3])
                            };
                        } else {
                            prop = { type: ptype, name: applyMapping(parts[1]) };
                        }
                        current.properties.push(prop);
                        break;
                    }

                    case "end_header":
                        break;
                }
            }
            if (current) header.elements.push(current);
            return header;
        }

        // ============================================================
        // Create model buffer
        // ============================================================
        function createBuffer() {
            const buf = {
                indices: [],
                vertices: [],
                normals: [],
                uvs: [],
                colors: []
            };
            return buf;
        }

        // ============================================================
        // Map element properties → x,y,z,r,g,b...
        // ============================================================
        function mapAttrs(props) {
            const names = props.map(p => p.name);
            const find = list => list.find(n => names.includes(n)) || null;

            return {
                x: find(['x']),
                y: find(['y']),
                z: find(['z']),
                r: find(['red']),
                g: find(['green']),
                b: find(['blue'])
            };
        }

        // ============================================================
        // Handle vertex / face
        // ============================================================
        function handleElement(buf, elemName, e, map) {
            if (elemName === "vertex") {
                buf.vertices.push(e[map.x], e[map.y], e[map.z]);

                if (map.r && map.g && map.b) {
                    _color.setRGB(
                        scope.normalizeColor(e[map.r]),
                        scope.normalizeColor(e[map.g]),
                        scope.normalizeColor(e[map.b])
                    );
                    buf.colors.push(_color.r, _color.g, _color.b);
                }
            }

            else if (elemName === "face") {
                const v = e.vertex_indices;
                if (v.length === 3) {
                    buf.indices.push(v[0], v[1], v[2]);
                } else if (v.length === 4) {
                    buf.indices.push(v[0], v[1], v[2]);
                    buf.indices.push(v[2], v[3], v[0]);
                }
            }
        }

        // ============================================================
        // Post process → build THREE.BufferGeometry
        // ============================================================
        function buildGeometry(buf) {
            const geo = new BufferGeometry();

            if (buf.indices.length > 0)
                geo.setIndex(buf.indices);

            geo.setAttribute('position', new Float32BufferAttribute(buf.vertices, 3));

            if (buf.colors.length > 0)
                geo.setAttribute('color', new Float32BufferAttribute(buf.colors, 3));

            geo.computeBoundingSphere();
            return geo;
        }

        // ============================================================
        // ASCII parser
        // ============================================================
        function parseASCII(text, header) {
            const buffer = createBuffer();
            const body = text.split("end_header")[1].trim().split(/\s+/);

            let idx = 0;
            function next() { return body[idx++]; }

            function read(type) {
                if (['char','uchar','short','ushort','int','uint','int8','uint8','int16','uint16','int32','uint32']
                    .includes(type)) return parseInt(next());
                return parseFloat(next());
            }

            for (const elem of header.elements) {
                const map = mapAttrs(elem.properties);

                for (let i=0; i<elem.count; i++) {
                    const e = {};
                    for (const p of elem.properties) {
                        if (p.type === 'list') {
                            const len = read(p.countType);
                            e[p.name] = [];
                            for (let k=0; k<len; k++) e[p.name].push(read(p.itemType));
                        } else {
                            e[p.name] = read(p.type);
                        }
                    }
                    handleElement(buffer, elem.name, e, map);
                }
            }

            return buildGeometry(buffer);
        }
        // ============================================================
        // Binary parser helpers
        // ============================================================
        function getReader(type, dv, little) {
            switch (type) {
                case 'char': case 'int8':   return { size:1, read: o => dv.getInt8(o) };
                case 'uchar': case 'uint8': return { size:1, read: o => dv.getUint8(o) };
                case 'short': case 'int16': return { size:2, read: o => dv.getInt16(o, little) };
                case 'ushort': case 'uint16': return { size:2, read: o => dv.getUint16(o, little) };
                case 'int': case 'int32':   return { size:4, read: o => dv.getInt32(o, little) };
                case 'uint': case 'uint32': return { size:4, read: o => dv.getUint32(o, little) };
                case 'float': case 'float32': return { size:4, read: o => dv.getFloat32(o, little) };
                case 'double': case 'float64': return { size:8, read: o => dv.getFloat64(o, little) };
            }
        }

        function parseBinary(arraybuffer, header) {
            const little = header.format === 'binary_little_endian';
            const buffer = createBuffer();

            const bytes = new Uint8Array(arraybuffer);
            const dv = new DataView(arraybuffer, header.headerLength);

            let offset = 0;

            for (const elem of header.elements) {
                const props = elem.properties;

                // Build readers
                const readers = props.map(p => {
                    if (p.type === 'list') {
                        return {
                            isList: true,
                            countReader: getReader(p.countType, dv, little),
                            itemReader: getReader(p.itemType, dv, little),
                            name: p.name
                        };
                    } else {
                        return {
                            isList: false,
                            reader: getReader(p.type, dv, little),
                            name: p.name
                        };
                    }
                });

                const map = mapAttrs(props);

                for (let i=0; i<elem.count; i++) {
                    const e = {};

                    for (const p of readers) {
                        if (p.isList) {
                            const count = p.countReader.read(offset);
                            offset += p.countReader.size;

                            const arr = [];
                            for (let k=0; k<count; k++) {
                                arr.push(p.itemReader.read(offset));
                                offset += p.itemReader.size;
                            }
                            e[p.name] = arr;
                        } else {
                            e[p.name] = p.reader.read(offset);
                            offset += p.reader.size;
                        }
                    }

                    handleElement(buffer, elem.name, e, map);
                }
            }

            return buildGeometry(buffer);
        }

        // ============================================================
        // MAIN PARSE
        // ============================================================
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
            // Already text
            const header = parseHeader(data);
            geometry = parseASCII(data, header);
        }

        return geometry;
    }
}

export { PLYLoader };
