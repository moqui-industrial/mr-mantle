spec({database: false})
const csv = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogCsv.js")
feature("catalog CSV accepts BOM, quoted separators, escaped quotes and embedded lines without losing empty cells", {
    expect() {
        const p = csv().parse(
            '\ufeffproductId;description;comments\r\nONE;"quoted; text";"two\nlines"\r\nTWO;"a ""quote""";\r\n',
            ";"
        )
        p.headers == ["productId", "description", "comments"]
        p.rows.length == 2
        p.rows[0].sourceValues.description == "quoted; text"
        p.rows[0].sourceValues.comments == "two\nlines"
        p.rows[1].sourceValues.description == 'a "quote"'
        p.rows[1].sourceValues.comments == ""
    }
})
feature("catalog CSV names malformed files and oversized rows instead of guessing their shape", {
    where: [
        {text: "a,a\nx,y", reason: "distinct"},
        {text: 'a\n"unclosed', reason: "closed"},
        {text: 'a\n"closed"x', reason: "Unexpected"},
        {text: "a\n", reason: "data row"}
    ],
    expect({text, reason}) {
        let message = ""
        try {
            csv().parse(text)
        } catch (e) {
            message = String(e)
        }
        message.includes(reason)
    }
})
feature("catalog report CSV quotes values and prevents spreadsheet formulas in uploaded text", {
    expect() {
        const data = csv().csv(["code", "result"], [{code: '=HYPERLINK("example")', result: "one, two"}])
        data.includes("'=HYPERLINK")
        data.includes('"one, two"')
        const parsed = csv().parse(data)
        parsed.rows[0].sourceValues.code.startsWith("'=")
    }
})
feature("CSV uploads reject malformed UTF-8 instead of storing replacement characters", {
    expect() {
        csv().validateUtf8([65, 194, 162, 226, 130, 172, 240, 159, 152, 128]) == true
        let rejected = 0
        for (const bytes of [[192, 128], [226, 130], [237, 160, 128], [244, 144, 128, 128], [255]]) {
            let error = ""
            try {
                csv().validateUtf8(bytes)
            } catch (e) {
                error = String(e)
            }
            if (error.includes("not valid UTF-8")) rejected++
        }
        rejected == 5
    }
})
