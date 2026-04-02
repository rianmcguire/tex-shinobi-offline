// TEX Shinobi Offline - Binary generator and .TEX file importer
// Replaces the yoda2.tedshd.io backend with client-side generation

(function() {
    'use strict';

    // ==================== TEX Binary Generator ====================

    var MAGIC = new Uint8Array([0x43, 0x59, 0x46, 0x49]); // "CYFI"
    var MACRO_SECTION_SIZE = 0x0280; // 640 bytes per macro section

    // Macro record types
    var MACRO_PRESS = 0x3c;
    var MACRO_RELEASE = 0x5c;
    var MACRO_TERMINATOR = 0xfc;

    // Backend record order: fn1Pos(0x94), fnTp(0x97), fn2Pos(0x95), fn3Pos(0x96)
    var fnPosTypeSpecs = [
        { key: 'fn1Pos', sub: 0x94 },
        { key: 'fnTp',   sub: 0x97 },
        { key: 'fn2Pos', sub: 0x95 },
        { key: 'fn3Pos', sub: 0x96 }
    ];
    var POS_TARGET_MAP = Object.fromEntries(
        fnPosTypeSpecs.map(s => [s.sub, s.key])
    );

    function encodeFnPos(posStr) {
        // "col,row" -> col*8 + row
        var parts = posStr.split(',');
        return parseInt(parts[0]) * 8 + parseInt(parts[1]);
    }

    function decodeFnPos(byte) {
        var col = Math.floor(byte / 8);
        var row = byte % 8;
        return col + ',' + row;
    }

    function encodeMacroRecords(macroEntries) {
        // Encode macro entries into 4-byte records
        // Each entry: {keyCode: [...], ts: number}
        // First half of keyCode = press (0x3c), second half = release (0x5c)
        // Returns array of 4-byte arrays
        var records = [];
        if (!macroEntries || !macroEntries.length) {
            // Just terminator
            records.push([0x00, MACRO_TERMINATOR, 0xc8, 0x00]);
            return records;
        }

        for (var i = 0; i < macroEntries.length; i++) {
            var entry = macroEntries[i];
            var keyCodes = entry.keyCode;
            var ts = entry.ts || 0;

            // Check for terminator entry: keyCode=['00'] or keyCode=[0]
            if (keyCodes.length === 1 && (keyCodes[0] === '00' || keyCodes[0] === 0)) {
                records.push([0x00, MACRO_TERMINATOR, 0xc8, 0x00]);
                return records;
            }

            var halfLen = Math.floor(keyCodes.length / 2);
            var tsLo = ts & 0xFF;
            var tsHi = (ts >> 8) & 0xFF;

            // First half: press records, second half: release records
            for (var j = 0; j < keyCodes.length; j++) {
                var kc = parseInt(keyCodes[j], 10);
                var type = j < halfLen ? MACRO_PRESS : MACRO_RELEASE;
                records.push([kc & 0xFF, type, tsLo, tsHi]);
            }
        }

        // Always end with terminator
        records.push([0x00, MACRO_TERMINATOR, 0xc8, 0x00]);
        return records;
    }

    function decodeMacroRecords(u8, offset, boundary) {
        // Decode 4-byte macro records from binary
        // Returns array of macro entries: [{keyCode: [...], ts: number}, ...]
        var entries = [];
        var currentPress = [];
        var currentRelease = [];
        var currentTs = 0;
        var off = offset;

        while (off + 4 <= boundary) {
            var keycode = u8[off];
            var type = u8[off + 1];
            var tsLo = u8[off + 2];
            var tsHi = u8[off + 3];

            if (type === MACRO_TERMINATOR) {
                // Flush any pending records as an entry
                if (currentPress.length || currentRelease.length) {
                    var keyCodes = currentPress.concat(currentRelease);
                    entries.push({ keyCode: keyCodes, ts: currentTs });
                    currentPress = [];
                    currentRelease = [];
                }
                // Preserve terminator so roundtrip is lossless
                entries.push({ keyCode: [0], ts: 0 });
                break;
            }

            if (keycode === 0xFF && type === 0xFF) break;

            var ts = tsLo | (tsHi << 8);
            var kcStr = ('0' + keycode.toString(10)).slice(-2);

            if (type === MACRO_PRESS) {
                // If we were collecting release records, flush previous entry
                if (currentRelease.length) {
                    entries.push({ keyCode: currentPress.concat(currentRelease), ts: currentTs });
                    currentPress = [];
                    currentRelease = [];
                }
                currentPress.push(kcStr);
                currentTs = ts;
            } else if (type === MACRO_RELEASE) {
                currentRelease.push(kcStr);
                currentTs = ts;
            }

            off += 4;
        }

        // Flush remaining
        if (currentPress.length || currentRelease.length) {
            entries.push({ keyCode: currentPress.concat(currentRelease), ts: currentTs });
        }

        return entries;
    }

    function generateTEX(generateData) {
        var profiles = ['profile1', 'profile2', 'profile3'];
        var numProfiles = profiles.length;

        // Count non-empty macro sections for header sizing
        var numMacroSections = 0;
        for (var p = 0; p < numProfiles; p++) {
            var md = generateData[profiles[p]].macro || {};
            for (var i = 1; i <= 12; i++) {
                if (md['macro_' + i] && md['macro_' + i].length) numMacroSections++;
            }
        }
        var numHeaderEntries = numProfiles + numMacroSections;
        var profileOffsets = [];
        var macroOffsets = [];

        // First pass: generate all profile data to know sizes
        var profileBuffers = [];
        for (var p = 0; p < numProfiles; p++) {
            var pdata = generateData[profiles[p]];
            var records = [];

            // Collect all key remap records
            // Backend order: all fn layers first, then all fnTop layers, then keyChange
            var sections = ['fn1', 'fn2', 'fn3', 'fn1Top', 'fn2Top', 'fn3Top', 'keyChange'];
            for (var s = 0; s < sections.length; s++) {
                var sec = pdata[sections[s]];
                if (!sec) continue;
                var keys = Object.keys(sec).map(Number).sort(function(a, b) { return a - b; });
                for (var k = 0; k < keys.length; k++) {
                    var entry = sec[keys[k]];
                    var idx = parseInt(entry.index);
                    var data = parseInt(entry.data);
                    records.push({ idx: idx, data: data });
                }
            }

            // Build per-type fn position records.
            // Each non-empty type gets its own record.
            var fnPosTypes = [];
            for (var f = 0; f < fnPosTypeSpecs.length; f++) {
                var spec = fnPosTypeSpecs[f];
                var posObj = pdata[spec.key];
                if (posObj) {
                    var posKeys = Object.keys(posObj);
                    if (posKeys.length > 0) {
                        var positions = [];
                        for (var pk = 0; pk < posKeys.length; pk++) {
                            positions.push(encodeFnPos(posKeys[pk]));
                        }
                        fnPosTypes.push({ sub: spec.sub, positions: positions });
                    }
                }
            }

            profileBuffers.push({ records: records, fnPosTypes: fnPosTypes });
        }

        var buf = new ArrayBuffer(65536);
        var view = new DataView(buf);
        var u8 = new Uint8Array(buf);
        u8.fill(0xFF);
        var offset = 0;

        // Header
        u8.set(MAGIC);
        view.setUint16(4, 0, true);
        view.setUint16(6, numHeaderEntries, true);
        offset += 8
        offset += numHeaderEntries * 8; // entry table filled later once offsets are known

        // Write key profile data
        var keyDataStart = offset;
        for (var p = 0; p < numProfiles; p++) {
            profileOffsets.push(offset);
            var pb = profileBuffers[p];

            for (var r = 0; r < pb.records.length; r++) {
                u8[offset] = 0x02;
                u8[offset + 1] = 0x20;
                view.setUint16(offset + 2, pb.records[r].idx, true);
                view.setUint16(offset + 4, pb.records[r].data, true);
                view.setUint16(offset + 6, 0, true);
                offset += 8;
            }

            // One fnpos (fn key position) record per non-empty position type
            // (fn1Pos=0x94, fn2Pos=0x95, fn3Pos=0x96, fnTp=0x97)
            for (var ft = 0; ft < pb.fnPosTypes.length; ft++) {
                var fpt = pb.fnPosTypes[ft];
                u8[offset] = 0x02;
                u8[offset + 1] = fpt.sub;
                view.setUint16(offset + 2, fpt.positions.length, true);
                for (var fp = 0; fp < Math.min(fpt.positions.length, 4); fp++) {
                    u8[offset + 4 + fp] = fpt.positions[fp];
                }
                offset += 8;
            }

            // Separator
            u8.fill(0x00, offset, offset + 8);
            offset += 8;
        }

        var keyDataLength = (offset - keyDataStart);

        // Write macro sections at 640-byte stride
        for (var p = 0; p < numProfiles; p++) {
            var macroData = (generateData[profiles[p]].macro) || {};
            for (var i = 1; i <= 12; i++) {
                var mkey = 'macro_' + i;
                if (!macroData[mkey] || !macroData[mkey].length) continue;
                var macroId = ((i - 1) << 16) | ((p + 1) << 8) | 0x01;
                macroOffsets.push({ id: macroId, offset: offset });
                var records = encodeMacroRecords(macroData[mkey]);
                for (var r = 0; r < records.length; r++) {
                    u8.set(records[r], offset);
                    offset += records[r].length;
                }
                offset = macroOffsets[macroOffsets.length - 1].offset + MACRO_SECTION_SIZE;
            }
        }

        // Write header entry table (profile entries, then macro entries)
        var entryOffset = 8;

        for (var p = 0; p < numProfiles; p++) {
            view.setUint32(entryOffset, (p + 1) * 0x100, true);
            view.setUint32(entryOffset + 4, profileOffsets[p], true);
            entryOffset += 8;
        }

        for (var m = 0; m < macroOffsets.length; m++) {
            view.setUint32(entryOffset, macroOffsets[m].id, true);
            view.setUint32(entryOffset + 4, macroOffsets[m].offset, true);
            entryOffset += 8;
        }

        // Trim the buffer to have the same padding length as the original
        // backend. This is empirical and doesn't make a lot of sense.
        //
        // "Actual extent" — the real data footprint, minus the macro header
        // entries.  The firmware sizes the file as if only the 3 profile
        // entries exist in the header (macros were added in a later revision?).
        var dataExtent = offset - numMacroSections * 8;
        //
        // "Minimum floor" — the firmware enforces a minimum file size:
        // 8K, plus a fixed 16-byte overhead, plus half the data (key + macro).
        var minimumFloor = 8192 + 16
            + Math.ceil(keyDataLength / 8 / 2) * 8 // half of the 8 byte records, rounded up
            + numMacroSections * (MACRO_SECTION_SIZE / 2);

        return buf.slice(0, Math.max(minimumFloor, dataExtent));
    }

    // ==================== TEX Binary Parser (for .TEX import) ====================

    function parseTEX(arrayBuffer) {
        var view = new DataView(arrayBuffer);
        var u8 = new Uint8Array(arrayBuffer);

        // Verify magic
        if (!u8.slice(0, MAGIC.length).every(function(b, i) { return b === MAGIC[i]; })) {
            throw new Error('Invalid .TEX file: bad magic');
        }

        var profileCount = view.getUint16(6, true);
        var profiles = {};
        var macros = {};

        // Collect all profile entries and separate key vs macro
        var keyEntries = [];
        var macroEntries = [];
        for (var pi = 0; pi < profileCount; pi++) {
            var eo = 8 + pi * 8;
            var id = view.getUint32(eo, true);
            var dataOffset = view.getUint32(eo + 4, true);
            if ((id & 0xFF) === 0x01) {
                macroEntries.push({ id: id, offset: dataOffset, index: pi });
            } else {
                keyEntries.push({ id: id, offset: dataOffset, index: pi });
            }
        }

        // Build sorted offset list for boundary detection from entries we already parsed
        var allOffsets = keyEntries.concat(macroEntries)
            .map(function(e) { return e.offset; })
            .concat([arrayBuffer.byteLength])
            .sort(function(a, b) { return a - b; });

        function getBoundary(offset) {
            for (var i = 0; i < allOffsets.length; i++) {
                if (allOffsets[i] > offset) return allOffsets[i];
            }
            return arrayBuffer.byteLength;
        }

        // Parse key profiles
        for (var kp = 0; kp < keyEntries.length; kp++) {
            var ke = keyEntries[kp];
            var profileNum = (ke.id >> 8) & 0xFF;
            var profileName = 'profile' + profileNum;
            var dataOffset = ke.offset;
            var boundary = getBoundary(dataOffset);

            var profile = {
                keyChange: {},
                fn1: {}, fn2: {}, fn3: {},
                fn1Top: {}, fn2Top: {}, fn3Top: {},
                fn1Pos: {}, fn2Pos: {}, fn3Pos: {},
                fnTp: {}
            };

            // Parse key remap records, splitting fn vs fnTop using transitions.
            // Generator order: fn1, fn2, fn3, fn1Top, fn2Top, fn3Top, keyChange.
            // Ranges: 0=256-511, 1=512-767, 2=768-1023. Within each section
            // indices ascend. The fn→fnTop boundary is where either:
            //   - the range decreases (e.g. range 2 → range 0), or
            //   - the index decreases within the same range
            var fnNames = [['fn1', 'fn1Top'], ['fn2', 'fn2Top'], ['fn3', 'fn3Top']];
            var lastRange = -1;
            var lastIdx = -1;
            var inTop = false;

            var off = dataOffset;
            while (off + 8 <= boundary) {
                var cmd = u8[off];
                var sub = u8[off + 1];

                if (cmd === 0xFF && sub === 0xFF) break;
                if (cmd === 0x00 && sub === 0x00) { off += 8; continue; }

                var idx = view.getUint16(off + 2, true);
                var data = view.getUint16(off + 4, true);

                if (cmd === 0x02 && sub === 0x20) {
                    var entry = { index: idx, data: data };
                    if (idx < 256) {
                        profile.keyChange[idx] = entry;
                    } else {
                        var range = idx < 512 ? 0 : idx < 768 ? 1 : 2;
                        if (!inTop && lastRange >= 0 &&
                            (range < lastRange || (range === lastRange && idx < lastIdx))) {
                            inTop = true;
                        }
                        lastRange = range;
                        lastIdx = idx;
                        var target = fnNames[range][inTop ? 1 : 0];
                        profile[target][idx] = entry;
                    }
                } else if (cmd === 0x02 && POS_TARGET_MAP[sub]) {
                    var posTarget = POS_TARGET_MAP[sub];
                    var count = idx;
                    for (var fp = 0; fp < Math.min(count, 4); fp++) {
                        var posByte = u8[off + 4 + fp];
                        if (posByte !== 0xFF) {
                            var posStr = decodeFnPos(posByte);
                            profile[posTarget][posStr] = posStr;
                        }
                    }
                }
                off += 8;
            }

            profiles[profileName] = profile;
        }

        // Parse macro sections
        for (var mi = 0; mi < macroEntries.length; mi++) {
            var me = macroEntries[mi];
            var macroProfileNum = (me.id >> 8) & 0xFF;
            var macroSourceIdx = (me.id >> 16) & 0xFF;
            var profileName = 'profile' + macroProfileNum;
            var sourceName = 'macro_' + (macroSourceIdx + 1);
            var boundary = getBoundary(me.offset);

            var entries = decodeMacroRecords(u8, me.offset, boundary);

            if (!macros[profileName]) macros[profileName] = {};
            macros[profileName][sourceName] = entries;
        }

        // Attach macros to profiles
        for (var pname in profiles) {
            profiles[pname].macro = macros[pname] || {};
        }

        return profiles;
    }

    if (typeof module !== 'undefined') module.exports = { generateTEX: generateTEX, parseTEX: parseTEX };
})();
