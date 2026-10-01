# Network Recorder v1.6.0 baseline

## Authority

The retained owner-provided archive is the authoritative migration baseline for the initial repository import.

- historical filename: `EINV_Network_Recorder_v1.6.0(2).zip`
- canonical product name: **Network Recorder**
- version: `1.6.0`
- archive SHA-256: `eeb0cdfdf6323c96c6aea777ad9aed889522dc9de13e467b8f447723612e1db3`
- stable Extension ID: `paolfcaakecapidipfcfbbhgkpcmgcip`
- public-key DER SHA-256: `f0eb5200a420f838f5251176af2c628faaf4b5a1ecb920f7360701765d28c0a4`

## Baseline files

| File | SHA-256 |
| --- | --- |
| `background.js` | `29af5b5cd3640fb706297c07caae5135a32fb23a12725dae356f38611d7d19a1` |
| `content.js` | `973923e9670104c18110581ab6a960ca04edf979c8c824d9d77d31a15807b726` |
| `offscreen.js` | `e66ae3d5859f864cc8d5f54ae790d87e8f863dd203679c2e668eb40b81552431` |
| `manifest.json` | baseline archive member; source-repository copy is normalized as described below |
| `offscreen.html` | baseline archive member |

## Manifest normalization

The retained v1.6.0 manifest contains the public RSA `key` field that anchors the historical Extension ID.

The repository source manifest is intentionally normalized to omit that literal public-key value. The release build must derive/inject the matching public key from the configured signing secret before packaging, and it must fail unless the resulting Extension ID is exactly:

`paolfcaakecapidipfcfbbhgkpcmgcip`

This normalization must not be interpreted as authorization to rotate or replace the signing key.

## Migration invariant

No functional changes to v1.6.0 are authorized as part of the baseline import. Later experimental versions 1.6.1–1.6.5 are not the baseline and must not be silently substituted.
