/**
 * Serial numbers identify a device and the account it is bound to, so they are masked everywhere
 * they could be read by someone else — logs at info level, `<name>/info`, issue reports
 * (ROADMAP.md E-2). The full SN appears at debug level only, and in captures it is replaced
 * altogether (lib/capture.js).
 */

/** Prefix (device family + region) and the last two characters: `BK01Z…9K`. */
export function maskSn(sn) {
    if (typeof sn !== 'string' || sn.length <= 8) {
        return sn ? '…' : '';
    }
    return `${sn.slice(0, 5)}…${sn.slice(-2)}`;
}

/**
 * The placeholder captures use: the family prefix, then X for every remaining character, so the
 * string keeps its length and frames stay byte-compatible (`BK01ZXXXXXXXXXXX`).
 */
export function placeholderSn(sn) {
    if (typeof sn !== 'string' || sn.length <= 5) {
        return 'X'.repeat(typeof sn === 'string' ? sn.length : 0);
    }
    return sn.slice(0, 5) + 'X'.repeat(sn.length - 5);
}

/** Model name from the SN prefix (R §1); undefined for an unknown prefix. */
export function modelOf(sn) {
    if (typeof sn !== 'string') {
        return undefined;
    }
    const prefix = sn.slice(0, 4).toUpperCase();
    if (prefix === 'BK01' || prefix === 'BK02' || prefix === 'N011') {
        return 'STREAM Microinverter';
    }
    if (prefix === 'HW51') {
        return 'PowerStream';
    }
    return undefined;
}
