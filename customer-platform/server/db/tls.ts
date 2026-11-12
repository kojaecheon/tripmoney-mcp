import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';

// Dashboard의 공식 공개 CA다. 키체인이나 시스템 신뢰 저장소는 변경하지 않는다.
// 출처: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
const approvedFingerprint = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

export function databaseTls(): { rejectUnauthorized: true; ca: string } {
  try {
    const pem = fs.readFileSync(new URL('./certs/supabase-root-2021.crt', import.meta.url), 'utf8');
    if ((pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) throw new Error();
    const certificate = new X509Certificate(pem);
    const now = Date.now();
    if (certificate.fingerprint256 !== approvedFingerprint || !certificate.ca
      || !certificate.verify(certificate.publicKey)
      || !(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) throw new Error();
    return { rejectUnauthorized: true, ca: certificate.toString() };
  } catch { throw new Error('customer_db_tls_configuration'); }
}
