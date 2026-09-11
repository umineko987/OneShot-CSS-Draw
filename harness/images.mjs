// Image processing extracted from @earendil-works/pi-coding-agent 0.85.1 (MIT).
// Keep encoding, resizing and EXIF behavior; no TUI, worker or resource loader.
import photonModule from '@silvia-odwyer/photon-node';

function readOrientationFromTiff(bytes, tiffStart) {
    if (tiffStart + 8 > bytes.length)
        return 1;
    const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
    const le = byteOrder === 0x4949;
    const read16 = (pos) => {
        if (le)
            return bytes[pos] | (bytes[pos + 1] << 8);
        return (bytes[pos] << 8) | bytes[pos + 1];
    };
    const read32 = (pos) => {
        if (le)
            return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
        return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    };
    const ifdOffset = read32(tiffStart + 4);
    const ifdStart = tiffStart + ifdOffset;
    if (ifdStart + 2 > bytes.length)
        return 1;
    const entryCount = read16(ifdStart);
    for (let i = 0; i < entryCount; i++) {
        const entryPos = ifdStart + 2 + i * 12;
        if (entryPos + 12 > bytes.length)
            return 1;
        if (read16(entryPos) === 0x0112) {
            const value = read16(entryPos + 8);
            return value >= 1 && value <= 8 ? value : 1;
        }
    }
    return 1;
}
function findJpegTiffOffset(bytes) {
    let offset = 2;
    while (offset < bytes.length - 1) {
        if (bytes[offset] !== 0xff)
            return -1;
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
            offset++;
            continue;
        }
        if (marker === 0xe1) {
            if (offset + 4 >= bytes.length)
                return -1;
            const segmentStart = offset + 4;
            if (segmentStart + 6 > bytes.length)
                return -1;
            if (hasExifHeader(bytes, segmentStart))
                return segmentStart + 6;
        }
        if (offset + 4 > bytes.length)
            return -1;
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 2 + length;
    }
    return -1;
}
function findWebpTiffOffset(bytes) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
        const dataStart = offset + 8;
        if (chunkId === "EXIF") {
            if (dataStart + chunkSize > bytes.length)
                return -1;
            // Some WebP files have "Exif\0\0" prefix before the TIFF header
            const tiffStart = chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
            return tiffStart;
        }
        // RIFF chunks are padded to even size
        offset = dataStart + chunkSize + (chunkSize % 2);
    }
    return -1;
}
function hasExifHeader(bytes, offset) {
    return (bytes[offset] === 0x45 &&
        bytes[offset + 1] === 0x78 &&
        bytes[offset + 2] === 0x69 &&
        bytes[offset + 3] === 0x66 &&
        bytes[offset + 4] === 0x00 &&
        bytes[offset + 5] === 0x00);
}
function getExifOrientation(bytes) {
    let tiffOffset = -1;
    // JPEG: starts with FF D8
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        tiffOffset = findJpegTiffOffset(bytes);
    }
    // WebP: starts with RIFF....WEBP
    else if (bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50) {
        tiffOffset = findWebpTiffOffset(bytes);
    }
    if (tiffOffset === -1)
        return 1;
    return readOrientationFromTiff(bytes, tiffOffset);
}
function rotate90(photon, image, dstIndex) {
    const w = image.get_width();
    const h = image.get_height();
    const src = image.get_raw_pixels();
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const srcIdx = (y * w + x) * 4;
            const dstIdx = dstIndex(x, y, w, h) * 4;
            dst[dstIdx] = src[srcIdx];
            dst[dstIdx + 1] = src[srcIdx + 1];
            dst[dstIdx + 2] = src[srcIdx + 2];
            dst[dstIdx + 3] = src[srcIdx + 3];
        }
    }
    return new photon.PhotonImage(dst, h, w);
}
// Flip orientations mutate in-place. Rotations return a new image (caller must free the old one if different).
export function applyExifOrientation(photon, image, originalBytes) {
    const orientation = getExifOrientation(originalBytes);
    if (orientation === 1)
        return image;
    switch (orientation) {
        case 2:
            photon.fliph(image);
            return image;
        case 3:
            photon.fliph(image);
            photon.flipv(image);
            return image;
        case 4:
            photon.flipv(image);
            return image;
        case 5: {
            const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
            photon.fliph(rotated);
            return rotated;
        }
        case 6:
            return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
        case 7: {
            const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
            photon.fliph(rotated);
            return rotated;
        }
        case 8:
            return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
        default:
            return image;
    }
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;
const DEFAULT_OPTIONS = {
    maxWidth: 2000,
    maxHeight: 2000,
    maxBytes: DEFAULT_MAX_BYTES,
    jpegQuality: 80,
};
function encodeCandidate(buffer, mimeType) {
    const data = Buffer.from(buffer).toString("base64");
    return {
        data,
        encodedSize: Buffer.byteLength(data, "utf-8"),
        mimeType,
    };
}
/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(inputBytes, mimeType, options) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
    const photon = photonModule;
    if (!photon) {
        return null;
    }
    let image;
    try {
        const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
        image = applyExifOrientation(photon, rawImage, inputBytes);
        if (image !== rawImage)
            rawImage.free();
        const originalWidth = image.get_width();
        const originalHeight = image.get_height();
        const format = mimeType.split("/")[1] ?? "png";
        // Check if already within all limits (dimensions AND encoded size)
        if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
            return {
                data: Buffer.from(inputBytes).toString("base64"),
                mimeType: mimeType || `image/${format}`,
                originalWidth,
                originalHeight,
                width: originalWidth,
                height: originalHeight,
                wasResized: false,
            };
        }
        // Calculate initial dimensions respecting max limits
        let targetWidth = originalWidth;
        let targetHeight = originalHeight;
        if (targetWidth > opts.maxWidth) {
            targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
            targetWidth = opts.maxWidth;
        }
        if (targetHeight > opts.maxHeight) {
            targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
            targetHeight = opts.maxHeight;
        }
        function tryEncodings(width, height, jpegQualities) {
            const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
            try {
                const candidates = [encodeCandidate(resized.get_bytes(), "image/png")];
                for (const quality of jpegQualities) {
                    candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
                }
                return candidates;
            }
            finally {
                resized.free();
            }
        }
        const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
        let currentWidth = targetWidth;
        let currentHeight = targetHeight;
        while (true) {
            const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
            for (const candidate of candidates) {
                if (candidate.encodedSize < opts.maxBytes) {
                    return {
                        data: candidate.data,
                        mimeType: candidate.mimeType,
                        originalWidth,
                        originalHeight,
                        width: currentWidth,
                        height: currentHeight,
                        wasResized: true,
                    };
                }
            }
            if (currentWidth === 1 && currentHeight === 1) {
                break;
            }
            const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
            const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
            if (nextWidth === currentWidth && nextHeight === currentHeight) {
                break;
            }
            currentWidth = nextWidth;
            currentHeight = nextHeight;
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        if (image) {
            image.free();
        }
    }
}

export async function convertImageBytesToPng(bytes) {
    const photon = photonModule;
    if (!photon) {
        // Photon not available, can't convert
        return null;
    }
    try {
        const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
        const image = applyExifOrientation(photon, rawImage, bytes);
        if (image !== rawImage)
            rawImage.free();
        try {
            return new Uint8Array(image.get_bytes());
        }
        finally {
            image.free();
        }
    }
    catch {
        // Conversion failed
        return null;
    }
}

export function formatDimensionNote(result) {
    if (!result.wasResized) {
        return undefined;
    }
    const scale = result.originalWidth / result.width;
    return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

function baseMimeType(mimeType) {
    return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}
function normalizeSupportedImageMimeType(mimeType) {
    switch (baseMimeType(mimeType)) {
        case "image/png":
            return "image/png";
        case "image/jpeg":
        case "image/jpg":
            return "image/jpeg";
        case "image/gif":
            return "image/gif";
        case "image/webp":
            return "image/webp";
        default:
            return null;
    }
}
async function normalizeImage(bytes, mimeType) {
    const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
    if (normalizedMimeType) {
        return { bytes, mimeType: normalizedMimeType };
    }
    const pngBytes = await convertImageBytesToPng(bytes);
    if (!pngBytes) {
        return null;
    }
    return {
        bytes: pngBytes,
        mimeType: "image/png",
        convertedFrom: baseMimeType(mimeType),
    };
}
function conversionHint(from, to) {
    if (!from || from === to)
        return undefined;
    return `[Image converted from ${from} to ${to}.]`;
}
export async function processImage(bytes, mimeType, options) {
    const autoResizeImages = options?.autoResizeImages ?? true;
    const normalized = await normalizeImage(bytes, mimeType);
    if (!normalized) {
        return {
            ok: false,
            message: "[Image omitted: could not be converted to a supported inline image format.]",
        };
    }
    if (autoResizeImages) {
        const resized = await resizeImageInProcess(normalized.bytes, normalized.mimeType, options?.resizeOptions);
        if (!resized) {
            return {
                ok: false,
                message: "[Image omitted: could not be resized below the inline image size limit.]",
            };
        }
        const hints = [];
        const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
        if (convertedHint)
            hints.push(convertedHint);
        const dimensionNote = formatDimensionNote(resized);
        if (dimensionNote)
            hints.push(dimensionNote);
        return {
            ok: true,
            data: resized.data,
            mimeType: resized.mimeType,
            hints,
        };
    }
    const hints = [];
    const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
    if (convertedHint)
        hints.push(convertedHint);
    return {
        ok: true,
        data: Buffer.from(normalized.bytes).toString("base64"),
        mimeType: normalized.mimeType,
        hints,
    };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export function detectSupportedImageMimeType(buffer) {
    if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
        return buffer[3] === 0xf7 ? null : "image/jpeg";
    }
    if (startsWith(buffer, PNG_SIGNATURE)) {
        return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
    }
    if (startsWithAscii(buffer, 0, "GIF")) {
        return "image/gif";
    }
    if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
        return "image/webp";
    }
    if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
        return "image/bmp";
    }
    return null;
}
function isPng(buffer) {
    return buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}
function isAnimatedPng(buffer) {
    let offset = PNG_SIGNATURE.length;
    while (offset + 8 <= buffer.length) {
        const chunkLength = readUint32BE(buffer, offset);
        const chunkTypeOffset = offset + 4;
        if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
        if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
        const nextOffset = offset + 8 + chunkLength + 4;
        if (nextOffset <= offset || nextOffset > buffer.length) return false;
        offset = nextOffset;
    }
    return false;
}
function isBmp(buffer) {
    if (buffer.length < 26) return false;
    const declaredFileSize = readUint32LE(buffer, 2);
    const pixelDataOffset = readUint32LE(buffer, 10);
    const dibHeaderSize = readUint32LE(buffer, 14);
    if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
    if (pixelDataOffset < 14 + dibHeaderSize) return false;
    if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
    let colorPlanes, bitsPerPixel;
    if (dibHeaderSize === 12) {
        colorPlanes = readUint16LE(buffer, 22);
        bitsPerPixel = readUint16LE(buffer, 24);
    } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
        if (buffer.length < 30) return false;
        colorPlanes = readUint16LE(buffer, 26);
        bitsPerPixel = readUint16LE(buffer, 28);
    } else {
        return false;
    }
    return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}
function readUint16LE(buffer, offset) {
    return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}
function readUint32BE(buffer, offset) {
    return ((buffer[offset] ?? 0) * 0x1000000 + ((buffer[offset + 1] ?? 0) << 16)
        + ((buffer[offset + 2] ?? 0) << 8) + (buffer[offset + 3] ?? 0));
}
function readUint32LE(buffer, offset) {
    return ((buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8)
        + ((buffer[offset + 2] ?? 0) << 16) + (buffer[offset + 3] ?? 0) * 0x1000000);
}
function startsWith(buffer, bytes) {
    return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}
function startsWithAscii(buffer, offset, text) {
    if (buffer.length < offset + text.length) return false;
    for (let index = 0; index < text.length; index++) {
        if (buffer[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
}
