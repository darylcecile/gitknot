import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { SignedXml } from 'xml-crypto';
import { C14N, RSA_SHA256, SAML_NS, SAML_PROTOCOL_NS, SIGNATURE_NS, escapeXml } from '../src/xml.ts';

export const testIssuer = 'https://idp.example.com';
export const oidcKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const otherKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

export async function oidcJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  return { keys: [{ ...await exportJWK(oidcKeyPair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
}

export function signOidcToken(claims: Record<string, unknown>, wrongKey = false): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(wrongKey ? otherKeyPair.privateKey : oidcKeyPair.privateKey);
}

export interface SamlEvidence {
  request_id: string; acs: string; audience: string; subject: string; external_id: string; email: string;
  assertion_id?: string; response_id?: string; issuer?: string; tenant?: string; recipient?: string;
  destination?: string; subject_in_response_to?: string; response_in_response_to?: string;
  not_before?: string; expires_at?: string; authn_at?: string; context?: string;
}

export function samlResponseXml(evidence: SamlEvidence): string {
  const time = new Date().toISOString();
  const expires = evidence.expires_at ?? new Date(Date.now() + 240_000).toISOString();
  const attrs = { tid: evidence.tenant ?? 'tenant-a', oid: evidence.external_id, email: evidence.email, email_verified: 'true', name: 'Enterprise member' };
  const aId = evidence.assertion_id ?? `_${Buffer.from(randomBytes(16)).toString('hex')}`;
  const rId = evidence.response_id ?? `_${Buffer.from(randomBytes(16)).toString('hex')}`;
  const issuer = evidence.issuer ?? testIssuer;
  return `<samlp:Response xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_NS}" xmlns:ds="${SIGNATURE_NS}" ID="${rId}" Version="2.0" IssueInstant="${time}" InResponseTo="${escapeXml(evidence.response_in_response_to ?? evidence.request_id)}" Destination="${escapeXml(evidence.destination ?? evidence.acs)}"><saml:Issuer>${escapeXml(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${aId}" Version="2.0" IssueInstant="${time}"><saml:Issuer>${escapeXml(issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escapeXml(evidence.subject)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escapeXml(evidence.subject_in_response_to ?? evidence.request_id)}" Recipient="${escapeXml(evidence.recipient ?? evidence.acs)}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${evidence.not_before ?? new Date(Date.now() - 1000).toISOString()}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${escapeXml(evidence.audience)}</saml:Audience></saml:AudienceRestriction><saml:OneTimeUse/></saml:Conditions><saml:AuthnStatement AuthnInstant="${evidence.authn_at ?? time}"><saml:AuthnContext><saml:AuthnContextClassRef>${escapeXml(evidence.context ?? 'https://refeds.org/profile/mfa')}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${Object.entries(attrs).map(([name, value]) => `<saml:Attribute Name="${name}"><saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue></saml:Attribute>`).join('')}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}

export function signSamlXml(xml: string, privateKey: string, certificate: string, responseSigned = true): string {
  let value = xml;
  for (const element of responseSigned ? ['Assertion', 'Response'] : ['Assertion']) {
    const signer = new SignedXml({ privateKey, publicCert: certificate, signatureAlgorithm: RSA_SHA256, canonicalizationAlgorithm: C14N });
    signer.addReference({ xpath: `//*[local-name()='${element}']`, transforms: [`${SIGNATURE_NS}enveloped-signature`, C14N], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    signer.computeSignature(value, { prefix: 'ds', location: { reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`, action: 'after' } });
    value = signer.getSignedXml();
  }
  return value;
}
