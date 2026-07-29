using System.Buffers.Binary;

namespace BeeDocs.Api.Services;

/// <summary>
/// Reads pixel dimensions straight out of image headers. The DOCX writer needs
/// them to size inline pictures; decoding the whole image would be wasteful and
/// would pull in an imaging dependency.
/// </summary>
public static class ImageInfo
{
    /// <summary>Returns (width, height) in pixels, or null when the format is unknown/corrupt.</summary>
    public static (int Width, int Height)? TryReadDimensions(ReadOnlySpan<byte> data)
    {
        if (data.Length < 16) return null;

        // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
        if (data is [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ..] && data.Length >= 24)
        {
            var width = (int)BinaryPrimitives.ReadUInt32BigEndian(data[16..20]);
            var height = (int)BinaryPrimitives.ReadUInt32BigEndian(data[20..24]);
            return Valid(width, height);
        }

        // GIF: "GIF87a"/"GIF89a", then little-endian uint16 width/height.
        if (data is [(byte)'G', (byte)'I', (byte)'F', ..])
        {
            var width = BinaryPrimitives.ReadUInt16LittleEndian(data[6..8]);
            var height = BinaryPrimitives.ReadUInt16LittleEndian(data[8..10]);
            return Valid(width, height);
        }

        // JPEG: walk the marker segments to the SOFn frame header.
        if (data is [0xFF, 0xD8, ..])
            return ReadJpeg(data);

        // WebP: "RIFF"…"WEBP" then a VP8/VP8L/VP8X chunk.
        if (data.Length >= 30 && data is [(byte)'R', (byte)'I', (byte)'F', (byte)'F', ..]
            && data[8..12].SequenceEqual("WEBP"u8))
            return ReadWebp(data);

        return null;
    }

    private static (int, int)? ReadJpeg(ReadOnlySpan<byte> data)
    {
        var i = 2;
        while (i + 9 < data.Length)
        {
            if (data[i] != 0xFF)
            {
                i++;
                continue;
            }

            var marker = data[i + 1];
            // Standalone markers carry no length.
            if (marker is 0xD8 or 0x01 || (marker >= 0xD0 && marker <= 0xD7))
            {
                i += 2;
                continue;
            }

            var length = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 2)..(i + 4)]);
            if (length < 2) return null;

            // SOF0–SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
            if (marker >= 0xC0 && marker <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
            {
                if (i + 9 >= data.Length) return null;
                var height = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 5)..(i + 7)]);
                var width = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 7)..(i + 9)]);
                return Valid(width, height);
            }

            i += 2 + length;
        }
        return null;
    }

    private static (int, int)? ReadWebp(ReadOnlySpan<byte> data)
    {
        var chunk = data[12..16];

        if (chunk.SequenceEqual("VP8X"u8) && data.Length >= 30)
        {
            // 24-bit little-endian, stored as (value - 1).
            var width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1;
            var height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1;
            return Valid(width, height);
        }

        if (chunk.SequenceEqual("VP8 "u8) && data.Length >= 30)
        {
            var width = BinaryPrimitives.ReadUInt16LittleEndian(data[26..28]) & 0x3FFF;
            var height = BinaryPrimitives.ReadUInt16LittleEndian(data[28..30]) & 0x3FFF;
            return Valid(width, height);
        }

        if (chunk.SequenceEqual("VP8L"u8) && data.Length >= 25)
        {
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(data[21..25]);
            var width = (int)(bits & 0x3FFF) + 1;
            var height = (int)((bits >> 14) & 0x3FFF) + 1;
            return Valid(width, height);
        }

        return null;
    }

    private static (int, int)? Valid(int width, int height) =>
        width > 0 && height > 0 && width < 100_000 && height < 100_000 ? (width, height) : null;
}
