param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,
    [Parameter(Mandatory = $true)]
    [string]$PrivateKeyBase64,
    [Parameter(Mandatory = $true)]
    [string]$OutputDir,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedExtensionId
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PrivateKeyBase64)) { throw "RSA_PRIVATE_KEY_BASE64 secret is empty or unavailable." }
if ($ExpectedExtensionId -notmatch '^[a-p]{32}$') { throw "Expected Extension ID is invalid." }
if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) { throw "Source directory not found." }

$manifestPath = Join-Path $SourceDir "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) { throw "Manifest version is empty." }

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$keyPath = Join-Path ([System.IO.Path]::GetTempPath()) ("network-recorder-key-" + [Guid]::NewGuid().ToString("N") + ".txt")
$payloadZip = Join-Path $OutputDir ("Network_Recorder_v" + $version + ".zip")

try {
    [System.IO.File]::WriteAllText($keyPath, $PrivateKeyBase64.Trim(), (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $payloadZip) { Remove-Item -LiteralPath $payloadZip -Force }
    Compress-Archive -Path (Join-Path $SourceDir "*") -DestinationPath $payloadZip -CompressionLevel Optimal

    $code = @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Collections.Generic;

public sealed class Crx3BuildResult
{
    public string ExtensionId { get; set; }
    public string CrxPath { get; set; }
    public string Sha256 { get; set; }
    public string PublicKeyBase64 { get; set; }
}

public static class NetworkRecorderCrx3
{
    private static byte[] Concat(params byte[][] arrays)
    {
        int total = 0;
        foreach (byte[] a in arrays) if (a != null) total += a.Length;
        byte[] result = new byte[total];
        int offset = 0;
        foreach (byte[] a in arrays)
        {
            if (a == null) continue;
            Buffer.BlockCopy(a, 0, result, offset, a.Length);
            offset += a.Length;
        }
        return result;
    }

    private static byte[] Varint(ulong value)
    {
        List<byte> bytes = new List<byte>();
        do
        {
            byte b = (byte)(value & 0x7FUL);
            value >>= 7;
            if (value != 0) b |= 0x80;
            bytes.Add(b);
        } while (value != 0);
        return bytes.ToArray();
    }

    private static byte[] ProtoBytes(int fieldNumber, byte[] data)
    {
        ulong key = ((ulong)fieldNumber << 3) | 2UL;
        return Concat(Varint(key), Varint((ulong)data.Length), data);
    }

    private static byte[] DerLength(int length)
    {
        if (length < 128) return new byte[] { (byte)length };
        List<byte> bytes = new List<byte>();
        int n = length;
        while (n > 0)
        {
            bytes.Insert(0, (byte)(n & 0xFF));
            n >>= 8;
        }
        byte[] result = new byte[1 + bytes.Count];
        result[0] = (byte)(0x80 | bytes.Count);
        for (int i = 0; i < bytes.Count; i++) result[i + 1] = bytes[i];
        return result;
    }

    private static byte[] DerWrap(byte tag, byte[] content)
    {
        return Concat(new byte[] { tag }, DerLength(content.Length), content);
    }

    private static byte[] DerInteger(byte[] unsignedBigEndian)
    {
        int start = 0;
        while (start < unsignedBigEndian.Length - 1 && unsignedBigEndian[start] == 0x00) start++;
        int len = unsignedBigEndian.Length - start;
        bool prependZero = (unsignedBigEndian[start] & 0x80) != 0;
        byte[] value = new byte[len + (prependZero ? 1 : 0)];
        int dst = prependZero ? 1 : 0;
        Buffer.BlockCopy(unsignedBigEndian, start, value, dst, len);
        return DerWrap(0x02, value);
    }

    private static byte[] BuildSubjectPublicKeyInfo(RSAParameters p)
    {
        byte[] rsaPublicKey = DerWrap(0x30, Concat(DerInteger(p.Modulus), DerInteger(p.Exponent)));
        byte[] algorithmIdentifier = new byte[]
        {
            0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7,
            0x0D, 0x01, 0x01, 0x01, 0x05, 0x00
        };
        byte[] subjectPublicKeyBitString = DerWrap(0x03, Concat(new byte[] { 0x00 }, rsaPublicKey));
        return DerWrap(0x30, Concat(algorithmIdentifier, subjectPublicKeyBitString));
    }

    private static string BuildExtensionId(byte[] publicKeyDer)
    {
        byte[] hash;
        using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(publicKeyDer);
        const string alphabet = "abcdefghijklmnop";
        StringBuilder sb = new StringBuilder(32);
        for (int i = 0; i < 16; i++)
        {
            byte b = hash[i];
            sb.Append(alphabet[(b >> 4) & 0x0F]);
            sb.Append(alphabet[b & 0x0F]);
        }
        return sb.ToString();
    }

    private static string Sha256File(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream fs = File.OpenRead(path))
        {
            byte[] hash = sha.ComputeHash(fs);
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    private static RSACryptoServiceProvider LoadKey(string keyPath)
    {
        string keyText = File.ReadAllText(keyPath, Encoding.UTF8).Trim();
        byte[] keyBlob = Convert.FromBase64String(keyText);
        CspParameters csp = new CspParameters(24);
        csp.Flags = CspProviderFlags.CreateEphemeralKey;
        RSACryptoServiceProvider rsa = new RSACryptoServiceProvider(2048, csp);
        rsa.PersistKeyInCsp = false;
        rsa.ImportCspBlob(keyBlob);
        return rsa;
    }

    public static Crx3BuildResult Generate(string zipPath, string outputDirectory, string keyPath)
    {
        byte[] zipBytes = File.ReadAllBytes(zipPath);
        if (zipBytes.Length < 2 || zipBytes[0] != 0x50 || zipBytes[1] != 0x4B)
            throw new InvalidDataException("Payload is not ZIP.");

        using (RSACryptoServiceProvider rsa = LoadKey(keyPath))
        {
            RSAParameters publicParameters = rsa.ExportParameters(false);
            byte[] publicKeyDer = BuildSubjectPublicKeyInfo(publicParameters);
            string extensionId = BuildExtensionId(publicKeyDer);

            byte[] idHash;
            using (SHA256 sha = SHA256.Create()) idHash = sha.ComputeHash(publicKeyDer);
            byte[] crxId = new byte[16];
            Buffer.BlockCopy(idHash, 0, crxId, 0, 16);

            byte[] signedHeaderData = ProtoBytes(1, crxId);
            byte[] signedBlob = Concat(
                Encoding.ASCII.GetBytes("CRX3 SignedData\0"),
                BitConverter.GetBytes((UInt32)signedHeaderData.Length),
                signedHeaderData,
                zipBytes
            );

            byte[] signature = rsa.SignData(signedBlob, CryptoConfig.MapNameToOID("SHA256"));
            if (!rsa.VerifyData(signedBlob, CryptoConfig.MapNameToOID("SHA256"), signature))
                throw new CryptographicException("Generated CRX signature verification failed.");

            byte[] proof = Concat(ProtoBytes(1, publicKeyDer), ProtoBytes(2, signature));
            byte[] header = Concat(ProtoBytes(2, proof), ProtoBytes(10000, signedHeaderData));
            byte[] crx = Concat(
                Encoding.ASCII.GetBytes("Cr24"),
                BitConverter.GetBytes((UInt32)3),
                BitConverter.GetBytes((UInt32)header.Length),
                header,
                zipBytes
            );

            string outputPath = Path.Combine(outputDirectory, "Network_Recorder.crx");
            File.WriteAllBytes(outputPath, crx);

            return new Crx3BuildResult
            {
                ExtensionId = extensionId,
                CrxPath = outputPath,
                Sha256 = Sha256File(outputPath),
                PublicKeyBase64 = Convert.ToBase64String(publicKeyDer)
            };
        }
    }
}
'@

    Add-Type -TypeDefinition $code -Language CSharp
    $result = [NetworkRecorderCrx3]::Generate($payloadZip, $OutputDir, $keyPath)
    $desiredCrxPath = Join-Path $OutputDir ("Network_Recorder_v" + $version + ".crx")
    if ($result.CrxPath -cne $desiredCrxPath) {
        if (Test-Path -LiteralPath $desiredCrxPath -PathType Leaf) { Remove-Item -LiteralPath $desiredCrxPath -Force }
        Move-Item -LiteralPath $result.CrxPath -Destination $desiredCrxPath -Force
        $result.CrxPath = $desiredCrxPath
    }

    if ($result.ExtensionId -cne $ExpectedExtensionId) {
        throw "Signing key produced unexpected Extension ID: $($result.ExtensionId)"
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$manifest.key)) {
        $manifestKeyBytes = [Convert]::FromBase64String(([string]$manifest.key).Trim())
        $actualKeyBytes = [Convert]::FromBase64String($result.PublicKeyBase64)
        if ($manifestKeyBytes.Length -ne $actualKeyBytes.Length) { throw "Private key does not match manifest public key." }
        for ($i = 0; $i -lt $manifestKeyBytes.Length; $i++) {
            if ($manifestKeyBytes[$i] -ne $actualKeyBytes[$i]) { throw "Private key does not match manifest public key." }
        }
    }

    $descriptor = [ordered]@{
        schema = "extension-installer-release"
        schema_version = 1
        slug = "network-recorder"
        version = $version
        extension_id = $result.ExtensionId
        crx_asset = [System.IO.Path]::GetFileName($result.CrxPath)
        crx_sha256 = $result.Sha256
    }

    $descriptorPath = Join-Path $OutputDir "extension-release.json"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($descriptorPath, (($descriptor | ConvertTo-Json -Depth 5) + [Environment]::NewLine), $utf8NoBom)

    [pscustomobject]@{
        Version = $version
        ExtensionId = $result.ExtensionId
        CrxPath = $result.CrxPath
        CrxSha256 = $result.Sha256
        DescriptorPath = $descriptorPath
        PayloadZip = $payloadZip
    }
}
finally {
    if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
        Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
    }
}
