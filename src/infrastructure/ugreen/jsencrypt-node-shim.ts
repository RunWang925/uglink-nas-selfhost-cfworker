import { createPublicKey, constants, publicEncrypt } from 'node:crypto';

/**
 * Node-only drop-in replacement for jsencrypt, applied via the esbuild alias
 * in scripts/build-node-gateway.mjs. The Cloudflare Worker bundle keeps using
 * the original browser-targeted jsencrypt; this shim implements the same
 * JSEncrypt surface (setPublicKey + encrypt) with RSAES-PKCS1-v1_5 so the
 * shared UGREEN session service runs unchanged on Node.js.
 */
export class JSEncrypt {
  private key: ReturnType<typeof createPublicKey> | null = null;

  setPublicKey(encodedPublicKey: string): void {
    const material = encodedPublicKey.trim();
    if (material.includes('-----BEGIN')) {
      // UGREEN's x-rsa-token decodes to a PEM whose body is SPKI but whose
      // labels say "RSA PUBLIC KEY" (PKCS#1) — try as-is, then relabel.
      try {
        this.key = createPublicKey({ key: material });
        return;
      } catch {
        // fall through to relabel / DER extraction below
      }
      const relabeled = material.replace(/RSA PUBLIC KEY/g, 'PUBLIC KEY');
      try {
        this.key = createPublicKey({ key: relabeled });
        return;
      } catch {
        // fall through to DER extraction below
      }
      const body = material
        .replace(/-----BEGIN [^-]+-----/, '')
        .replace(/-----END [^-]+-----/, '')
        .replace(/\s+/g, '');
      const der = Buffer.from(body, 'base64');
      try {
        this.key = createPublicKey({ key: der, format: 'der', type: 'spki' });
        return;
      } catch {
        this.key = createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
        return;
      }
    }
    const der = Buffer.from(encodedPublicKey, 'binary');
    try {
      this.key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch {
      this.key = createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
    }
  }

  encrypt(value: string): string | false {
    if (!this.key) return false;
    try {
      return publicEncrypt(
        { key: this.key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(value, 'utf8')
      ).toString('base64');
    } catch {
      return false;
    }
  }
}

export default JSEncrypt;
