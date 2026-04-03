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
            var kcStr = String(keycode);

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

            // Collect all records: key remaps (sub=0x20) and macro keys (sub=0x18).
            // fn macro keys: 0x18 record replaces the 0x20 record in the fn section.
            // fnTop macro keys: 0x20 with data=0 in fnTop section, 0x18 in keyChange section.
            var fnLayerOffsets = { fn1: 256, fn2: 512, fn3: 768, fn1Top: 256, fn2Top: 512, fn3Top: 768 };
            var fnLayerNums = { fn1: 1, fn2: 2, fn3: 3, fn1Top: 1, fn2Top: 2, fn3Top: 3 };
            var fnTopMacroRecords = []; // 0x18 records to interleave into keyChange

            // Backend order: all fn layers first, then all fnTop layers, then keyChange
            var sections = ['fn1', 'fn2', 'fn3', 'fn1Top', 'fn2Top', 'fn3Top', 'keyChange'];
            for (var s = 0; s < sections.length; s++) {
                var secName = sections[s];
                var sec = pdata[secName];
                if (!sec) continue;
                var keys = Object.keys(sec).map(Number).sort(function(a, b) { return a - b; });
                for (var k = 0; k < keys.length; k++) {
                    var entry = sec[keys[k]];
                    var dataStr = String(entry.data);
                    if (dataStr.charAt(0) === 'm' && fnLayerNums[secName]) {
                        var macroIdx = parseInt(dataStr.substring(1)) - 1;
                        var keyHex = parseInt(entry.index) - fnLayerOffsets[secName];
                        var isTop = secName.indexOf('Top') >= 0;
                        if (isTop) {
                            // fnTop: write 0x20 with data=0 here, queue 0x18 for keyChange.
                            // Only write 0x18 when the fn layer has remap entries.
                            records.push({ type: 0x20, idx: parseInt(entry.index), data: 0 });
                            var fnSec = pdata['fn' + fnLayerNums[secName]] || {};
                            var hasRemaps = Object.keys(fnSec).some(function(k) {
                                return String(fnSec[k].data).charAt(0) !== 'm';
                            });
                            if (hasRemaps) {
                                fnTopMacroRecords.push({ type: 0x18, macroIdx: macroIdx, keyHex: keyHex, fnLayer: fnLayerNums[secName], isTop: true });
                            }
                        } else {
                            // fn: 0x18 record replaces the 0x20 inline
                            records.push({ type: 0x18, macroIdx: macroIdx, keyHex: keyHex, fnLayer: fnLayerNums[secName], isTop: false });
                        }
                    } else {
                        var idx = parseInt(entry.index);
                        var data = parseInt(entry.data);
                        records.push({ type: 0x20, idx: idx, data: data });
                    }
                }
            }

            // fnTop 0x18 records go into the keyChange section, replacing
            // the 0x20 at the same keyHex and inserting extras after it.
            if (fnTopMacroRecords.length > 0) {
                var fnTopByKey = {};
                for (var fi = 0; fi < fnTopMacroRecords.length; fi++) {
                    var fk = fnTopMacroRecords[fi].keyHex;
                    if (!fnTopByKey[fk]) fnTopByKey[fk] = [];
                    fnTopByKey[fk].push(fnTopMacroRecords[fi]);
                }
                var merged = [];
                for (var ri = 0; ri < records.length; ri++) {
                    var rec = records[ri];
                    if (rec.type === 0x20 && rec.idx < 256 && fnTopByKey[rec.idx]) {
                        // Replace 0x20 with the 0x18 records for this key
                        var group = fnTopByKey[rec.idx];
                        for (var gi = 0; gi < group.length; gi++) merged.push(group[gi]);
                        delete fnTopByKey[rec.idx];
                    } else {
                        merged.push(rec);
                    }
                }
                records = merged;
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

            // Write key remap (sub=0x20) and macro (sub=0x18) records
            for (var r = 0; r < pb.records.length; r++) {
                var rec = pb.records[r];
                if (rec.type === 0x18) {
                    u8[offset] = 0x02;
                    u8[offset + 1] = 0x18;
                    view.setUint16(offset + 2, rec.macroIdx, true);
                    u8[offset + 4] = rec.keyHex;
                    u8[offset + 5] = rec.isTop ? 0x3c : (0x3d + rec.fnLayer - 1);
                    u8[offset + 6] = p + 1;
                    u8[offset + 7] = 0x00;
                } else {
                    u8[offset] = 0x02;
                    u8[offset + 1] = 0x20;
                    view.setUint16(offset + 2, rec.idx, true);
                    view.setUint16(offset + 4, rec.data, true);
                    view.setUint16(offset + 6, 0, true);
                }
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

                if (cmd === 0x02 && sub === 0x18) {
                    // Macro-on-fn record: assigns a macro to a key on an fn layer
                    var macroIdx = idx; // 0-based macro index
                    var keyHex = u8[off + 4];
                    var byte5 = u8[off + 5];
                    var isTop = byte5 === 0x3c; // 0x3c=fnTop, 0x3d=fn1, 0x3e=fn2, 0x3f=fn3
                    var fnLayer = isTop ? u8[off + 6] : (byte5 - 0x3d + 1);
                    var fnSection = 'fn' + fnLayer + (isTop ? 'Top' : '');
                    var fnIndex = keyHex + fnLayer * 256;
                    var macroName = 'm' + (macroIdx + 1);
                    profile[fnSection][fnIndex] = { index: fnIndex, data: macroName };
                    // fnTop 0x18 records replace the keyChange 0x20 at this position;
                    // the UI stores the macro reference in keyChange as well
                    if (isTop) {
                        profile.keyChange[keyHex] = { index: keyHex, data: macroName };
                    }
                } else if (cmd === 0x02 && sub === 0x20) {
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

    // ==================== UI Integration ====================

    if (typeof document === 'undefined') return;

    // Patch locationHashChanged to use relative routing instead of absolute /shinobi/
    var origLocationHashChanged = locationHashChanged;
    locationHashChanged = function(E) {
        var hash = location.hash.split('#')[1];
        var route = hash ? hash.split(',')[0] : '';
        var validRoutes = ['layout', 'macro', 'keymap', 'setting', 'download', 'test'];
        if (validRoutes.indexOf(route) === -1) {
            // Default case: use relative hash instead of absolute /shinobi/#layout
            location.hash = '#layout';
            return;
        }
        origLocationHashChanged(E);
    };
    window.onhashchange = locationHashChanged;

    // Override the download button to use client-side generation
    var origViewDownload = TEX.VIEW.download;
    var downloadPatched = false;

    TEX.VIEW.download = function(E) {
        if (origViewDownload) origViewDownload(E);
        if (downloadPatched) return;
        downloadPatched = true;

        setTimeout(function() {
            var dolBtn = document.querySelector('#dol_btn');
            if (!dolBtn) return;

            // Replace click handler
            var newBtn = dolBtn.cloneNode(true);
            dolBtn.parentNode.replaceChild(newBtn, dolBtn);

            newBtn.addEventListener('click', function(ev) {
                ev.preventDefault();
                try {
                    var data = TEX.filterGenerateData();
                    var binary = generateTEX(data);
                    var blob = new Blob([binary], { type: 'application/octet-stream' });
                    var a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'KEYMAP.TEX';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(a.href);
                } catch (err) {
                    alert('Error generating .TEX file: ' + err.message);
                    console.error(err);
                }
            });
        }, 500);
    };

    // Set up Import .TEX handler on the header nav element
    (function setupImport() {
        var importLi = document.querySelector('#import_tex');
        if (!importLi) return;

        var importLink = importLi.querySelector('a');
        var fileInput = importLi.querySelector('input[type="file"]');

        importLink.addEventListener('click', function() {
            fileInput.click();
        });

        fileInput.addEventListener('change', function() {
            if (!fileInput.files.length) return;
            var reader = new FileReader();
            reader.onload = function(e) {
                try {
                    var imported = parseTEX(e.target.result);

                    // Build reverse keycode lookup (hex → display name) from
                    // TEX.KEYCAPSCATEGORY and the keyboard layout template
                    var hexToName = {};
                    // First, pull from the layout template (has modifiers, FN keys, etc.)
                    var tmpl = TEX.LAYOUT[TEX.DATA.keyboard] && TEX.LAYOUT[TEX.DATA.keyboard][TEX.DATA.layoutType];
                    if (tmpl) {
                        for (var tp in tmpl) {
                            var tRows = tmpl[tp];
                            for (var tri = 0; tri < tRows.length; tri++) {
                                var tr = tRows[tri];
                                if (!tr.hex || !tr.val) continue;
                                for (var tci = 0; tci < tr.hex.length; tci++) {
                                    if (tr.hex[tci] != null && tr.val[tci] && hexToName[tr.hex[tci]] === undefined) {
                                        hexToName[tr.hex[tci]] = tr.val[tci];
                                    }
                                }
                            }
                        }
                    }
                    // Then, overlay with KEYCAPSCATEGORY (key picker display names)
                    for (var cat in TEX.KEYCAPSCATEGORY) {
                        var rows = TEX.KEYCAPSCATEGORY[cat];
                        if (!Array.isArray(rows)) continue;
                        for (var ri = 0; ri < rows.length; ri++) {
                            var row = rows[ri];
                            if (!row.hex || !row.val) continue;
                            for (var ci = 0; ci < row.hex.length; ci++) {
                                if (row.hex[ci] != null && hexToName[row.hex[ci]] === undefined) {
                                    hexToName[row.hex[ci]] = row.val[ci];
                                }
                            }
                        }
                    }
                    function keycodeName(code) {
                        return hexToName[code] !== undefined ? hexToName[code] : null;
                    }

                    // Detect layout type from fn1Top indices — fn1Top has
                    // entries for ALL keys in the layout (index = hex + 256).
                    // ISO-only keys: CODE42 (50), CODE45 (100)
                    // JIS-only keys: CODE14 (137), CODE56 (135), CODE131 (139),
                    //                CODE132 (138), CODE133 (136)
                    var detectedLayout = 'ansi';
                    var fn1Top = imported.profile1 && imported.profile1.fn1Top;
                    if (fn1Top) {
                        if (fn1Top[256 + 137] || fn1Top[256 + 135] || fn1Top[256 + 139]) {
                            detectedLayout = 'jis';
                        } else if (fn1Top[256 + 50] || fn1Top[256 + 100]) {
                            detectedLayout = 'iso';
                        }
                    }
                    if (detectedLayout !== TEX.DATA.layoutType) {
                        TEX.DATA.layoutType = detectedLayout;
                        var radio = document.querySelector('#radio_' + detectedLayout);
                        if (radio) radio.checked = true;
                    }

                    // Rebuild everything from scratch by resetting the view
                    // status flags and re-running the full init sequence.
                    // This mimics what happens when the user changes layout type.
                    TEX.POOL = {};
                    TEX.DATA.currentLayer = 'd4';
                    TEX.VIEW.status.layout = false;
                    TEX.VIEW.status.keymap = false;

                    // dataLayoutInit: resets GENERATE + DATA.layout to defaults,
                    // rebuilds DOM, populates all layers from LAYOUT template
                    TEX.dataLayoutInit();

                    // Now overwrite GENERATE with imported data (for .TEX export)
                    // and patch DATA.layout so the UI reflects the remapped keys.
                    var profiles = ['profile1', 'profile2', 'profile3'];
                    for (var pi = 0; pi < profiles.length; pi++) {
                        var pname = profiles[pi];
                        if (!imported[pname] || !TEX.GENERATE[pname]) continue;
                        var parsed = imported[pname];

                        // Overwrite GENERATE
                        var genKeys = ['keyChange','fn1','fn2','fn3','fn1Top','fn2Top','fn3Top','fn1Pos','fn2Pos','fn3Pos','fnTp'];
                        for (var gi = 0; gi < genKeys.length; gi++) {
                            if (parsed[genKeys[gi]]) TEX.GENERATE[pname][genKeys[gi]] = parsed[genKeys[gi]];
                        }

                        // Patch DATA.layout d4: apply keyChange remaps
                        var d4Rows = TEX.DATA.layout[pname] && TEX.DATA.layout[pname].d4;
                        if (d4Rows) {
                            for (var idx in parsed.keyChange) {
                                var kc = parsed.keyChange[idx];
                                var hexIdx = kc.index;
                                var hexData = kc.data;
                                if (hexIdx === hexData) continue; // not actually changed
                                for (var r = 0; r < d4Rows.length; r++) {
                                    for (var c = 0; c < d4Rows[r].hex.length; c++) {
                                        if (d4Rows[r].hex[c] === hexIdx) {
                                            d4Rows[r].hexCustom[c] = hexData;
                                            var name = keycodeName(hexData);
                                            if (name !== null) d4Rows[r].valCustom[c] = name;
                                        }
                                    }
                                }
                            }
                        }

                        // Patch DATA.layout fn layers
                        var fnDefs = [
                            { gen: 'fn1', data: 'fn1', offset: 256 },
                            { gen: 'fn2', data: 'fn2', offset: 512 },
                            { gen: 'fn3', data: 'fn3', offset: 768 }
                        ];
                        for (var fi = 0; fi < fnDefs.length; fi++) {
                            var def = fnDefs[fi];
                            var fnRows = TEX.DATA.layout[pname] && TEX.DATA.layout[pname][def.data];
                            if (!fnRows || !parsed[def.gen]) continue;
                            for (var fnIdx in parsed[def.gen]) {
                                var fnEntry = parsed[def.gen][fnIdx];
                                var fHexIdx = fnEntry.index;
                                var fHexData = fnEntry.data;
                                var origHex = fHexIdx - def.offset;
                                for (var r = 0; r < fnRows.length; r++) {
                                    for (var c = 0; c < fnRows[r].hex.length; c++) {
                                        if (fnRows[r].hex[c] === origHex) {
                                            fnRows[r].hexFn[c] = fHexData;
                                            var fnName = keycodeName(fHexData);
                                            if (fnName !== null) fnRows[r].fn[c] = fnName;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Apply fnPos to DATA.layout d4: set valCustom to "FN1"/"FN2"/"FN3"
                    // at the imported positions so the UI shows the FN key labels
                    var fnPosMap = [
                        { gen: 'fn1Pos', label: 'FN1' },
                        { gen: 'fn2Pos', label: 'FN2' },
                        { gen: 'fn3Pos', label: 'FN3' }
                    ];
                    var profiles2 = ['profile1', 'profile2', 'profile3'];
                    for (var pi2 = 0; pi2 < profiles2.length; pi2++) {
                        var pn = profiles2[pi2];
                        if (!imported[pn]) continue;
                        var d4 = TEX.DATA.layout[pn] && TEX.DATA.layout[pn].d4;
                        if (!d4) continue;
                        for (var fpi = 0; fpi < fnPosMap.length; fpi++) {
                            var fnp = fnPosMap[fpi];
                            var importedPos = imported[pn][fnp.gen] || {};
                            for (var r = 0; r < d4.length; r++) {
                                for (var c = 0; c < d4[r].colRow.length; c++) {
                                    var cr = d4[r].colRow[c];
                                    // Key is at an imported FN position but wasn't FN by default → label it
                                    if (importedPos[cr] && d4[r].val[c] !== fnp.label) {
                                        d4[r].valCustom[c] = fnp.label;
                                    }
                                    // Key was FN by default but isn't in imported fnPos → show its remapped value
                                    if (d4[r].val[c] === fnp.label && !importedPos[cr]) {
                                        // Use the already-applied keyChange valCustom if set,
                                        // otherwise look up from hexCustom
                                        if (!d4[r].valCustom[c]) {
                                            var kcName = keycodeName(d4[r].hexCustom[c]);
                                            d4[r].valCustom[c] = kcName !== null ? kcName : d4[r].val[c];
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Apply macro data – convert from export format
                    // ({keyCode:[...], ts}) to editor format ({stickyKey:[...], ts}).
                    // keyCode is [press0, press1, ..., releaseN, ..., release0]
                    // where presses = stickyKey keycodes, releases = reversed.
                    // So first half of keyCode = the press keycodes.
                    if (imported.profile1 && imported.profile1.macro) {
                        var convertedMacro = {};
                        var impMacro = imported.profile1.macro;
                        for (var mkey in impMacro) {
                            var mEntries = impMacro[mkey];
                            var converted = [];
                            for (var me = 0; me < mEntries.length; me++) {
                                var mEntry = mEntries[me];
                                var kc = mEntry.keyCode;
                                // Terminator entry
                                if (kc.length === 1 && (kc[0] === 0 || kc[0] === '0')) {
                                    continue; // skip terminator, UI adds it on export
                                }
                                var halfLen = Math.floor(kc.length / 2);
                                var sticky = [];
                                for (var sk = 0; sk < halfLen; sk++) {
                                    var code = String(kc[sk]);
                                    var name = keycodeName(parseInt(code, 10));
                                    sticky.push({ keyCode: code, key: name !== null ? name : code });
                                }
                                converted.push({ stickyKey: sticky, ts: mEntry.ts || 128 });
                            }
                            if (!converted.length) {
                                converted.push({ stickyKey: [], ts: 128 });
                            }
                            convertedMacro[mkey] = converted;
                        }
                        // Ensure all 12 macro slots exist
                        for (var ms = 1; ms <= 12; ms++) {
                            var msKey = 'macro_' + ms;
                            if (!convertedMacro[msKey]) {
                                convertedMacro[msKey] = [{ stickyKey: [], ts: 128 }];
                            }
                        }
                        TEX.DATA.macro = convertedMacro;
                    }

                    // Refresh macro button enable/disable state
                    if (TEX.updateMarco) TEX.updateMarco();

                    // Final re-render with patched data.
                    // dataLayoutUpdate re-renders d4 keyboards, then
                    // dataLayoutFnInit rebuilds FN layer tabs and keyboards.
                    TEX.dataLayoutUpdate();

                    // Re-trigger keymap view init so profile switching
                    // and keycap click handlers get re-attached
                    if (TEX.VIEW.keymap) TEX.VIEW.keymap();

                    console.log('TEX config imported successfully');
                } catch (err) {
                    alert('Error importing .TEX file: ' + err.message);
                    console.error(err);
                }
            };
            reader.readAsArrayBuffer(fileInput.files[0]);
            fileInput.value = '';
        });
    })();
})();
