// A wiki space's public page, attachment and blog addresses are patterns: fill(pattern, values) puts in each ${name} the
// value of that name as URL-encoded text (pagePath a segment at a time, a name with no value nothing), and never runs the
// stored text as a template (SEC-SCR-81, SEC-BAP-87). Mantle's article links (request/Knowledge.js) and mr-marble's wiki
// screens use it. CC0 plus patent grant.
function fill(pattern, values) {
    const given = values || {}
    return String(pattern || "").replace(/\$\{\s*(\w+)\s*\}/g, (match, name) =>
        name === "pagePath"
            ? String(given.pagePath || "")
                  .split("/")
                  .map(part => encodeURIComponent(part))
                  .join("/")
            : encodeURIComponent(String(Object.prototype.hasOwnProperty.call(given, name) ? (given[name] ?? "") : ""))
    )
}

;({fill})
