import { deflateRawSync } from "node:zlib";

export interface ZipOptions {
    /** Deflate every entry but the mimetype, as most EPUB tools do */
    deflate?: boolean;
    /** Write sizes and CRC in a data descriptor after each deflated entry, as streaming ZIP writers do */
    descriptors?: boolean;
}

/** Build small EPUB files for tests, stored (uncompressed) unless asked otherwise. */
export function zip(entries: [name: string, content: string][], options: ZipOptions = {}): Uint8Array {
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of entries) {
        const nameBytes = Buffer.from(name);
        const raw = Buffer.from(content);
        const deflate = options.deflate && name !== "mimetype";
        const descriptor = deflate && options.descriptors;
        const data = deflate ? deflateRawSync(raw) : raw;
        const crc = Bun.hash.crc32(raw);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(descriptor ? 0x08 : 0, 6);
        header.writeUInt16LE(deflate ? 8 : 0, 8);
        if (!descriptor) {
            header.writeUInt32LE(crc, 14);
            header.writeUInt32LE(data.length, 18);
            header.writeUInt32LE(raw.length, 22);
        }
        header.writeUInt16LE(nameBytes.length, 26);
        local.push(header, nameBytes, data);
        let length = header.length + nameBytes.length + data.length;
        if (descriptor) {
            const trailer = Buffer.alloc(16);
            trailer.writeUInt32LE(0x08074b50, 0);
            trailer.writeUInt32LE(crc, 4);
            trailer.writeUInt32LE(data.length, 8);
            trailer.writeUInt32LE(raw.length, 12);
            local.push(trailer);
            length += trailer.length;
        }

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(descriptor ? 0x08 : 0, 8);
        entry.writeUInt16LE(deflate ? 8 : 0, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(raw.length, 24);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBytes);
        offset += length;
    }
    const centralSize = central.reduce((sum, b) => sum + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

export const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

export const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Loomings</a></li></ol></nav></body>
</html>`;

export const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><title>Loomings</title></head>
<body><h1>Chapter 1. Loomings.</h1><p>Call me Ishmael.</p></body>
</html>`;

function opf(title: string, extraManifest = ""): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:7c4b4a4e-4f6b-4b8e-9d55-3f0d1e2b2701</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>Herman Melville</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-10-29T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>${extraManifest}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
}

/** A valid EPUB 3. */
export function validEpub(title = "Moby Dick"): Uint8Array {
    return zip([
        ["mimetype", "application/epub+zip"],
        ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf(title)],
        ["OEBPS/nav.xhtml", NAV],
        ["OEBPS/chapter1.xhtml", CHAPTER],
    ]);
}

/**
 * An EPUB epubsana can repair: a chapter with a script but no "scripted" property (OPF-014, a safe fix),
 * and a manifest entry for an image that is not in the file (RSC-001, a fix to confirm).
 */
export function repairableEpub(title = "Moby Dick"): Uint8Array {
    const scripted = CHAPTER.replace("<title>Loomings</title>", "<title>Loomings</title><script>var whale = true;</script>");
    return zip([
        ["mimetype", "application/epub+zip"],
        ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf(title, `\n    <item id="whale" href="images/whale.jpg" media-type="image/jpeg"/>`)],
        ["OEBPS/nav.xhtml", NAV],
        ["OEBPS/chapter1.xhtml", scripted],
    ]);
}

export const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="7c4b4a4e-4f6b-4b8e-9d55-3f0d1e2b2701"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
  <docTitle><text>Moby Dick</text></docTitle>
  <navMap><navPoint id="n1" playOrder="1"><navLabel><text>Loomings</text></navLabel><content src="chapter1.xhtml"/></navPoint></navMap>
</ncx>`;

export const CHAPTER_2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Loomings</title></head><body><p>Call me Ishmael.</p></body></html>`;

/** The calibre metas BookOrbit writes for a series */
export const CALIBRE_SERIES = `
    <meta name="calibre:series" content="The Whale &amp; Co"/>
    <meta name="calibre:series_index" content="1"/>`;

/** The EPUB 3 metas BookOrbit's write-back adds, also to EPUB 2 books */
export const BOOKORBIT_SERIES = `
    <meta id="series-col" property="belongs-to-collection">The Whale &amp; Co</meta>
    <meta refines="#series-col" property="collection-type">series</meta>
    <meta refines="#series-col" property="group-position">1</meta>`;

export function opf2(metadata: string, manifest = ""): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="uid" opf:scheme="uuid">7c4b4a4e-4f6b-4b8e-9d55-3f0d1e2b2701</dc:identifier>
    <dc:title>Moby Dick</dc:title>
    <dc:language>en</dc:language>${metadata}
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>${manifest}
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`;
}

/** An EPUB 2 with the given OPF metadata; by default as BookOrbit's write-back leaves it: calibre and EPUB 3 series metas. */
export function epub2(metadata = CALIBRE_SERIES + BOOKORBIT_SERIES, options: ZipOptions = {}, manifest = ""): Uint8Array {
    return zip([
        ["mimetype", "application/epub+zip"],
        ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf2(metadata, manifest)],
        ["OEBPS/toc.ncx", NCX],
        ["OEBPS/chapter1.xhtml", CHAPTER_2],
    ], options);
}

/** A manifest entry for an image that is not in the book (RSC-001, which epubsana fixes once confirmed) */
export const MISSING_IMAGE = `
    <item id="whale" href="images/whale.jpg" media-type="image/jpeg"/>`;

/** An EPUB whose manifest lists an image that is not in the file: an error, not fatal. */
export function brokenEpub(title = "Moby Dick"): Uint8Array {
    return zip([
        ["mimetype", "application/epub+zip"],
        ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf(title, `\n    <item id="whale" href="images/whale.jpg" media-type="image/jpeg"/>`)],
        ["OEBPS/nav.xhtml", NAV],
        ["OEBPS/chapter1.xhtml", CHAPTER],
    ]);
}
