/**
 * Fully fixed PLYLoader for Three.js
 * 修复点：
 *  - 正确读取 binary 顶点，无 padding（你的模型 stride = 15 bytes）
 *  - 不再假设 4 字节对齐
 *  - 完全按 header 属性顺序解析
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
        loader.load(
            url,
            data => {
                try {
                    onLoad(scope.parse(data));
                } catch (e) {
                    console.error(e);
                }
            },
            onProgress,
            onError
        );
    }

    normalizeColor(v) {
        return (v > 1.0) ? v / 255.0 : v;
    }

    /*** 读取 header 文本 ***/
    extractHeader(bytes) {
        let idx = 0, line = "", lines = [];
        while (idx < bytes.length) {
            const c = String.fromCharCode(bytes[idx++]);
            if (c !== '\n' && c !== '\r') line += c;
            else {
                lines.push(line);
                if (line === "end_header") break;
                line = "";
            }
        }
        return { headerText: lines.join("\n"), headerLength: idx };
    }

    /*** 解析 header 结构 ***/
    parseHeader(text, headerLength = 0) {
        const header = {
            format: "",
            version: "",
            elements: [],
            headerLength
        };

        const lines = text.split(/\r?\n/);
        let current = null;

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            const parts = line.split(/\s+/);
            const key = parts.shift();

            switch (key) {
                case "format":
                    header.format = parts[0];
                    header.version = parts[1];
                    break;

                case "element":
                    if (current) header.elements.push(current);
                    current = { name: parts[0], count: parseInt(parts[1]), properties: [] };
                    break;

                case "property":
                    if (parts[0] === "list") {
                        current.properties.push({
                            type: "list",
                            countType: parts[1],
                            itemType: parts[2],
                            name: parts[3]
                        });
                    } else {
                        current.properties.push({
                            type: parts[0],
                            name: parts[1]
                        });
                    }
                    break;

                case "end_header":
                    break;
            }
        }
        if (current) header.elements.push(current);
        return header;
    }

    /*** 获得数据类型读取器 ***/
    getReader(type, dv, little) {
        switch (type) {
            case 'char': case 'int8': return { size: 1, read: o => dv.getInt8(o) };
            case 'uchar': case 'uint8': return { size: 1, read: o => dv.getUint8(o) };
            case 'short': case 'int16': return { size: 2, read: o => dv.getInt16(o, little) };
            case 'ushort': case 'uint16': return { size: 2, read: o => dv.getUint16(o, little) };
            case 'int': case 'int32': return { size: 4, read: o => dv.getInt32(o, little) };
            case 'uint': case 'uint32': return { size: 4, read: o => dv.getUint32(o, little) };
            case 'float': case 'float32': return { size: 4, read: o => dv.getFloat32(o, little) };
            case 'double': case 'float64': return { size: 8, read: o => dv.getFloat64(o, little) };
        }
    }

    /*** 主解析函数 ***/
    parse(data) {
        const bytes = new Uint8Array(data);
        const { headerText, headerLength } = this.extractHeader(bytes);
        const header = this.parseHeader(headerText, headerLength);

        if (header.format === "ascii") {
            return this.parseASCII(bytes, header);
        } else {
            return this.parseBinary(bytes, header);
        }
    }

    /*** ASCII 解析（保持原样） ***/
    parseASCII(bytes, header) {
        const text = new TextDecoder().decode(bytes);
        const body = text.split("end_header")[1].trim().split(/\s+/);

        let idx = 0;
        const next = () => body[idx++];

        function read(type) {
            if (['char','uchar','short','ushort','int','uint','int8','uint8','int16','uint16','int32','uint32']
                .includes(type)) return parseInt(next());
            return parseFloat(next());
        }

        const vertices = [];
        const colors = [];
        const indices = [];

        for (let elem of header.elements) {
            if (elem.name === "vertex") {
                for (let i = 0; i < elem.count; i++) {
                    let x, y, z, r, g, b;
                    for (let p of elem.properties) {
                        const val = read(p.type);
                        if (p.name === "x") x = val;
                        if (p.name === "y") y = val;
                        if (p.name === "z") z = val;
                        if (p.name === "red") r = val;
                        if (p.name === "green") g = val;
                        if (p.name === "blue") b = val;
                    }
                    vertices.push(x, y, z);
                    if (r != null) {
                        _color.setRGB(r/255, g/255, b/255);
                        colors.push(_color.r, _color.g, _color.b);
                    }
                }
            }

            if (elem.name === "face") {
                for (let i = 0; i < elem.count; i++) {
                    const len = parseInt(next());
                    const vs = [];
                    for (let k = 0; k < len; k++) vs.push(parseInt(next()));
                    if (vs.length === 3) indices.push(vs[0], vs[1], vs[2]);
                    if (vs.length === 4) {
                        indices.push(vs[0], vs[1], vs[2]);
                        indices.push(vs[2], vs[3], vs[0]);
                    }
                }
            }
        }

        return this.buildGeometry(vertices, colors, indices);
    }

    /*** 修正后的 Binary 解析（关键） ***/
    parseBinary(bytes, header) {
        const little = header.format === "binary_little_endian";
        const dv = new DataView(bytes.buffer, header.headerLength);

        let offset = 0;

        const vertices = [];
        const colors = [];
        const indices = [];

        for (let elem of header.elements) {
            const props = elem.properties;

            // 预计算真实 stride（无 padding）
            const propReaders = props.map(p => {
                if (p.type === "list") {
                    return {
                        isList: true,
                        name: p.name,
                        count: this.getReader(p.countType, dv, little),
                        item: this.getReader(p.itemType, dv, little)
                    };
                } else {
                    return {
                        isList: false,
                        name: p.name,
                        reader: this.getReader(p.type, dv, little)
                    };
                }
            });

            for (let i = 0; i < elem.count; i++) {

                let x, y, z, r, g, b;

                if (elem.name === "vertex") {
                    for (let p of propReaders) {
                        if (p.isList) throw new Error("顶点不应有 list 属性");

                        const v = p.reader.read(offset);
                        offset += p.reader.size;

                        if (p.name === "x") x = v;
                        if (p.name === "y") y = v;
                        if (p.name === "z") z = v;
                        if (p.name === "red") r = v;
                        if (p.name === "green") g = v;
                        if (p.name === "blue") b = v;
                    }

                    vertices.push(x, y, z);
                    if (r != null) {
                        _color.setRGB(r/255, g/255, b/255);
                        colors.push(_color.r, _color.g, _color.b);
                    }
                }

                else if (elem.name === "face") {
                    const p = propReaders[0];
                    const count = p.count.read(offset);
                    offset += p.count.size;

                    const vs = [];
                    for (let k = 0; k < count; k++) {
                        vs.push(p.item.read(offset));
                        offset += p.item.size;
                    }

                    if (vs.length === 3) indices.push(vs[0], vs[1], vs[2]);
                    if (vs.length === 4) {
                        indices.push(vs[0], vs[1], vs[2]);
                        indices.push(vs[2], vs[3], vs[0]);
                    }
                }
            }
        }

        return this.buildGeometry(vertices, colors, indices);
    }

    buildGeometry(vertices, colors, indices) {
        const geo = new BufferGeometry();
        geo.setAttribute("position", new Float32BufferAttribute(vertices, 3));
        if (colors.length === vertices.length)
            geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
        if (indices.length > 0)
            geo.setIndex(indices);
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        return geo;
    }
}

export { PLYLoader };
