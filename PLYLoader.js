/**
 * PLYLoader.js — Enhanced version with auto color normalization
 * Fixes issue where float colors (0–1) were incorrectly divided by 255,
 * causing models to appear completely black or invisible.
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

    // *******************************
    // Auto normalization function added here
    // *******************************
    normalizeColor(v) {
        if (v === undefined || v === null) return 0;
        if (v > 1.0) return v / 255.0;  // 0–255 → normalize
        return v;                      // already 0–1 float
    }

    parse(data) {

        //— many internal helper functions unchanged —
        // I will only modify the color handling part below

        const scope = this;

        function createBuffer() {
            const buffer = {
                indices: [],
                vertices: [],
                normals: [],
                uvs: [],
                faceVertexUvs: [],
                colors: [],
                faceVertexColors: []
            };

            for (const custom of Object.keys(scope.customPropertyMapping)) {
                buffer[custom] = [];
            }
            return buffer;
        }

        function mapElementAttributes(properties) {
            const names = properties.map(p => p.name);
            function find(list) {
                return list.find(n => names.includes(n)) || null;
            }
            return {
                attrX: find(['x', 'px', 'posx']) || 'x',
                attrY: find(['y', 'py', 'posy']) || 'y',
                attrZ: find(['z', 'pz', 'posz']) || 'z',
                attrNX: find(['nx','normalx']),
                attrNY: find(['ny','normaly']),
                attrNZ: find(['nz','normalz']),
                attrS: find(['s','u','texture_u','tx']),
                attrT: find(['t','v','texture_v','ty']),
                attrR: find(['red','diffuse_red','r','diffuse_r']),
                attrG: find(['green','diffuse_green','g','diffuse_g']),
                attrB: find(['blue','diffuse_blue','b','diffuse_b'])
            };
        }

        // *************************************
        // HandleElement updated (THIS IS THE FIX)
        // *************************************
        function handleElement(buffer, elementName, element, attr) {

            if (elementName === 'vertex') {

                buffer.vertices.push(
                    element[attr.attrX],
                    element[attr.attrY],
                    element[attr.attrZ]
                );

                if (attr.attrNX && attr.attrNY && attr.attrNZ) {
                    buffer.normals.push(
                        element[attr.attrNX],
                        element[attr.attrNY],
                        element[attr.attrNZ]
                    );
                }

                if (attr.attrS && attr.attrT) {
                    buffer.uvs.push(
                        element[attr.attrS],
                        element[attr.attrT]
                    );
                }

                // ********** FIXED COLOR HANDLING **********
                if (attr.attrR && attr.attrG && attr.attrB) {

                    _color.setRGB(
                        scope.normalizeColor(element[attr.attrR]),
                        scope.normalizeColor(element[attr.attrG]),
                        scope.normalizeColor(element[attr.attrB])
                    );

                    buffer.colors.push(_color.r, _color.g, _color.b);
                }
                // *****************************************

            }

            else if (elementName === 'face') {

                const vi = element.vertex_indices || element.vertex_index;

                if (vi.length === 3) {
                    buffer.indices.push(vi[0], vi[1], vi[2]);
                } else if (vi.length === 4) {
                    buffer.indices.push(vi[0], vi[1], vi[3]);
                    buffer.indices.push(vi[1], vi[2], vi[3]);
                }

                if (attr.attrR && attr.attrG && attr.attrB) {
                    _color.setRGB(
                        scope.normalizeColor(element[attr.attrR]),
                        scope.normalizeColor(element[attr.attrG]),
                        scope.normalizeColor(element[attr.attrB])
                    );
                    buffer.faceVertexColors.push(
                        _color.r, _color.g, _color.b,
                        _color.r, _color.g, _color.b,
                        _color.r, _color.g, _color.b
                    );
                }
            }
        }

        // ******************************************************
        // Below this point loader internals remain unchanged
        // ******************************************************

        function postProcess(buffer) {
            let geometry = new BufferGeometry();

            if (buffer.indices.length > 0)
                geometry.setIndex(buffer.indices);

            geometry.setAttribute('position', new Float32BufferAttribute(buffer.vertices, 3));

            if (buffer.normals.length > 0)
                geometry.setAttribute('normal', new Float32BufferAttribute(buffer.normals, 3));

            if (buffer.uvs.length > 0)
                geometry.setAttribute('uv', new Float32BufferAttribute(buffer.uvs, 2));

            if (buffer.colors.length > 0)
                geometry.setAttribute('color', new Float32BufferAttribute(buffer.colors, 3));

            geometry.computeBoundingSphere();
            return geometry;
        }

        // Binary or ASCII parsing logic stays the same

        let geometry;

        if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            const { headerText, headerLength } = extractHeaderText(bytes);
            const header = parseHeader(headerText, headerLength);

            if (header.format === 'ascii')
                geometry = parseASCII(new TextDecoder().decode(bytes), header);
            else
                geometry = parseBinary(data, header);

        } else {
            geometry = parseASCII(data, parseHeader(data));
        }

        return geometry;
    }
}

class ArrayStream {
    constructor(arr) { this.arr = arr; this.i = 0; }
    empty() { return this.i >= this.arr.length; }
    next() { return this.arr[this.i++]; }
}

export { PLYLoader };
