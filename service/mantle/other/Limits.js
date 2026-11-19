/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Mantle's count limits (MoquiConf.xml, the mantle element, where each default is written): a whole number, 0 for no
 * limit. One that is missing or not a whole number is refused rather than guessed. */
function limit(name) {
    const text = ec.factory.getConfValue("mantle@" + name)
    const value = Number(text)
    if (text == null || String(text).trim() === "" || !Number.isInteger(value) || value < 0)
        throw new Error("mantle@" + name + " is not a count: a whole number, 0 for no limit")
    return value === 0 ? Infinity : value
}
;({limit})
