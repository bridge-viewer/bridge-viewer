/**
 * Fully fixed PLYLoader for Three.js
 * 修复点：
 *  - 正确读取 binary 顶点，无 padding
 *  - end_header 后无换行也能解析
 *  - header 里混入乱码也能解析
 *  - 按 header 顺序逐字节解析
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
    }

    load(url, onLoad, onProgress, onError) {
        const loader = new FileLoader(this.manager);
        loader.setResponseType("arraybuffer");
        loader.load(url, data => {
            try {
                onLoad(this.parse(data));
            } catch (e) {
                console.error("PLY parse error:", e);
            }
        }, onProgress, onError);
    }

    normalizeColor(v) {
        return (v > 1.0 ? v/255.0 : v);
    }

    /******************************
     *  ★★★ 终极修复版 extractHeader ★★★
     *  - 精确字节匹配 "end_header"
     *  - 不依赖换行符
     *  - 兼容 header 后紧接二进制
     ******************************/
    extractHeader(bytes) {

        // ASCII of "end_header"
        const target = [101,110,100,95,104,101,97,100,101,114];
        let hit = 0;
        let headerEnd = -1;

        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === target[hit]) {
                hit++;
                if (hit === target.length) {
                    headerEnd = i + 1;
                    break;
                }
            } else {
                hit = 0;
            }
        }

        if (headerEnd < 0) {
            throw new Error("PLY header not found");
        }

        // 读取 header 文本（宽松转换）
        let txt = "";
        for (let i = 0; i < headerEnd; i++) {
            let c = bytes[i];
            if (c >= 32 && c <= 126) txt += String.fromCharCode(c);
            else txt += "\n";  // 控制字符强行替换为空行
        }

        return {
            headerText: txt,
            headerLength: headerEnd
        };
    }

    /*************** 解析 header 文本 ***************/
    parseHeader(text, headerLength=0) {
        const header = {
            format: "",
            elements: [],
            version: "",
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
                    current = {
                        name: parts[0],
                        count: parseInt(parts[1]),
                        properties: []
                    };
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

    /************ 二进制读取器 ************/
    getReader(type, dv, little) {
        switch (type) {
            case "char": case "int8": return { size:1, read:o=>dv.getInt8(o) };
            case "uchar": case "uint8": return { size:1, read:o=>dv.getUint8(o) };
            case "short": case "int16": return { size:2, read:o=>dv.getInt16(o,little) };
            case "ushort": case "uint16": return { size:2, read:o=>dv.getUint16(o,little) };
            case "int": case "int32": return { size:4, read:o=>dv.getInt32(o,little) };
            case "uint": case "uint32": return { size:4, read:o=>dv.getUint32(o,little) };
            case "float": case "float32": return { size:4, read:o=>dv.getFloat32(o,little) };
            case "double": case "float64": return { size:8, read:o=>dv.getFloat64(o,little) };
        }
    }

    /**************** 主解析入口 ****************/
    parse(data) {
        const bytes = new Uint8Array(data);

        const { headerText, headerLength } = this.extractHeader(bytes);
        const header = this.parseHeader(headerText, headerLength);

        if (header.format === "ascii") return this.parseASCII(bytes, header);
        return this.parseBinary(bytes, header);
    }

    /*************** ASCII（无变化） ***************/
    parseASCII(bytes, header) {
        const text = new TextDecoder().decode(bytes);
        const body = text.split("end_header")[1].trim().split(/\s+/);

        let idx = 0;
        const next = () => body[idx++];

        function read(t) {
            if (["char","uchar","short","ushort","int","uint",
                 "int8","uint8","int16","uint16","int32","uint32"].includes(t))
                return parseInt(next());
            return parseFloat(next());
        }

        const V=[],C=[],I=[];

        for (let elem of header.elements) {

            if (elem.name === "vertex") {
                for (let i = 0; i < elem.count; i++) {
                    let x,y,z,r,g,b;

                    for (let p of elem.properties) {
                        const v = read(p.type);
                        if (p.name==="x") x=v;
                        if (p.name==="y") y=v;
                        if (p.name==="z") z=v;
                        if (p.name==="red") r=v;
                        if (p.name==="green") g=v;
                        if (p.name==="blue") b=v;
                    }

                    V.push(x,y,z);
                    if (r != null) {
                        _color.setRGB(r/255, g/255, b/255);
                        C.push(_color.r,_color.g,_color.b);
                    }
                }
            }

            if (elem.name === "face") {
                for (let i = 0; i < elem.count; i++) {
                    const len = parseInt(next());
                    const vs = [];
                    for (let k=0; k<len; k++) vs.push(parseInt(next()));
                    if (vs.length===3) I.push(vs[0],vs[1],vs[2]);
                    if (vs.length===4) {
                        I.push(vs[0],vs[1],vs[2], vs[2],vs[3],vs[0]);
                    }
                }
            }
        }

        return this.buildGeometry(V,C,I);
    }

    /**************** binary 解析（核心） ****************/
    parseBinary(bytes, header) {
        const little = header.format === "binary_little_endian";
        const dv = new DataView(bytes.buffer, header.headerLength);
        let offset = 0;

        const V=[], C=[], I=[];

        for (let elem of header.elements) {
            let props = elem.properties;

            const readers = props.map(p => {
                if (p.type === "list") {
                    return {
                        isList: true,
                        name: p.name,
                        count: this.getReader(p.countType, dv, little),
                        item: this.getReader(p.itemType, dv, little)
                    };
                }
                return {
                    isList: false,
                    name: p.name,
                    reader: this.getReader(p.type, dv, little)
                };
            });

            for (let i = 0; i < elem.count; i++) {

                let x,y,z,r,g,b;

                if (elem.name === "vertex") {

                    for (let p of readers) {
                        if (p.isList) throw new Error("顶点属性不能是 list");

                        const v = p.reader.read(offset);
                        offset += p.reader.size;

                        if(p.name==="x") x=v;
                        if(p.name==="y") y=v;
                        if(p.name==="z") z=v;

                        if(p.name==="red") r=v;
                        if(p.name==="green") g=v;
                        if(p.name==="blue") b=v;
                    }

                    V.push(x,y,z);
                    if(r!=null){
                        _color.setRGB(r/255,g/255,b/255);
                        C.push(_color.r,_color.g,_color.b);
                    }
                }
                else if (elem.name === "face") {
                    const p = readers[0];

                    const count = p.count.read(offset);
                    offset += p.count.size;

                    const vs = [];
                    for (let k = 0; k < count; k++) {
                        vs.push(p.item.read(offset));
                        offset += p.item.size;
                    }

                    if (vs.length===3) I.push(vs[0],vs[1],vs[2]);
                    else if (vs.length===4)
                        I.push(vs[0],vs[1],vs[2], vs[2],vs[3],vs[0]);
                }
            }
        }

        return this.buildGeometry(V,C,I);
    }


    /**************** geometry ***************/
    buildGeometry(V,C,I) {
        const geo = new BufferGeometry();
        geo.setAttribute("position", new Float32BufferAttribute(V,3));
        if (C.length === V.length)
            geo.setAttribute("color", new Float32BufferAttribute(C,3));
        if (I.length > 0)
            geo.setIndex(I);

        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        return geo;
    }
}

export { PLYLoader };
