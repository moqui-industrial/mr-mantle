// A public page's file (CX-PORTALS, impl-customer-service F58): staged under PASS's media root and scanned, as Forum stages an
// attachment, then kept as a record's content. Moved here from Accounting's Portal.js (a supplier's bill, Purchasing's quote and
// acknowledgement files) so the Support app's case files and return evidence (Customer Service P15) use the same rules: the
// file's leading bytes must be the PDF, PNG or JPEG it says it is, at most 10 MB, clean by pass_scanner_service, kept under a
// name whose extension is its type's; anything else is refused (Unprocessable), and with no scanner or media root nothing is
// received (Unavailable). CC0 1.0 Universal plus Grant of Patent License.
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const types = ["application/pdf", "image/png", "image/jpeg"]
const signatures = [
    {type: "application/pdf", extension: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d]},
    {type: "image/png", extension: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]},
    {type: "image/jpeg", extension: "jpg", bytes: [0xff, 0xd8, 0xff]}
]
const maxBytes = 10485760
// A file's type from its leading bytes; null for anything but a PDF, PNG or JPEG.
function sniff(location) {
    const stream = ec.resource.getLocationReference(location).openStream()
    let head
    try {
        head = Array.from(stream.readAllBytes().slice(0, 8)).map(b => b & 0xff)
    } finally {
        stream.close()
    }
    return signatures.find(sig => sig.bytes.every((b, i) => head[i] === b)) || null
}
// Stage and scan a file (a FileItem of a form post or a remote multipart request): {location, filename, byteSize, contentType}.
// noun names it in the refusals; folder is its place under the media root (bills, supplier, support).
function stage(file, noun = "file", folder = "support") {
    if (!file || Number(file.size) < 1 || Number(file.size) > maxBytes)
        fail("Unprocessable", "Attach the " + noun + ", at most 10 MB")
    const type = String(file.contentType || "")
    if (!types.includes(type)) fail("Unprocessable", "Attach the " + noun + " as a PDF, PNG or JPEG file")
    const scanner = System.getProperty("pass_scanner_service"),
        root = System.getProperty("pass_media_root")
    if (!scanner || !root) fail("Unavailable", "Files cannot be received now")
    const location = String(root).replace(/\/$/, "") + "/" + folder + "/" + ec.user.randomString(32)
    file.write(location)
    const refuse = (message, why) => {
        ec.resource.getLocationReference(location).delete()
        if (why) ec.logger.warn("Public " + noun + " file refused: " + why)
        fail("Unprocessable", message)
    }
    const kind = sniff(location)
    if (!kind || kind.type !== type) refuse("The file is not the PDF, PNG or JPEG it says it is", "content is not " + type)
    let clean = false
    try {
        clean = ec.service.sync().throwOnError(true).name(scanner).parameters({location, mimeType: type}).call().clean === true
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Public " + noun + " file at " + location + " could not be scanned; refused")
    }
    if (!clean) refuse("The file could not be accepted; send another copy")
    const base =
        String(file.name || noun)
            .replace(/\.[^.]*$/, "")
            .replace(/[^a-zA-Z0-9_ -]/g, "_")
            .slice(0, 90) || noun
    return {location, filename: base + "." + kind.extension, byteSize: Number(file.size), contentType: type}
}
// A file given (a FileItem with a size) staged, else null.
const stageGiven = (file, noun, folder) => (file && Number(file.size) > 0 ? stage(file, noun, folder) : null)
// Copy a staged file to its record's content location.
function keep(staged, location) {
    const stream = ec.resource.getLocationReference(staged.location).openStream()
    try {
        ec.resource.getLocationReference(location).putStream(stream)
    } finally {
        stream.close()
    }
    return location
}
// Remove a staged file once kept, or when its write failed; a failure is logged.
function unstage(staged) {
    if (!staged) return
    try {
        ec.resource.getLocationReference(staged.location).delete()
    } catch (error) {
        ec.logger.warn("Staged public file " + staged.location + " was not removed")
    }
}
// The content root of a record's files (mantle.content.large.root, else the database resource store).
const contentRoot = () => ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
// The type of a kept file by its name, for a download.
function typeOf(filename) {
    const name = String(filename || "").toLowerCase()
    if (name.endsWith(".pdf")) return "application/pdf"
    if (name.endsWith(".png")) return "image/png"
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg"
    if (name.endsWith(".txt")) return "text/plain"
    return "application/octet-stream"
}
;({types, sniff, stage, stageGiven, keep, unstage, contentRoot, typeOf})
