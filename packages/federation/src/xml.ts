import { X509Certificate } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Document, Element, Node } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { ApiError } from '@gitknot/core';
import { authenticationFailed } from './errors.ts';

export const SAML_XML_BYTES = 131_072;
export const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
export const SAML_PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
export const SIGNATURE_NS = 'http://www.w3.org/2000/09/xmldsig#';
export const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const canonicalizationMethods = new Set([C14N, 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315']);
const signatureMethods = new Set([RSA_SHA256, 'http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512']);
const digestMethods = new Set(['http://www.w3.org/2001/04/xmlenc#sha256', 'http://www.w3.org/2001/04/xmlenc#sha512']);

export function elements(node: Node, namespace?: string, name?: string): Element[] {
  const result: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (namespace === undefined || child.namespaceURI === namespace) && (name === undefined || child.localName === name)) result.push(child as Element);
  }
  return result;
}

export function child(node: Node, namespace: string, name: string): Element {
  const matches = elements(node, namespace, name);
  if (matches.length !== 1) throw authenticationFailed();
  return matches[0]!;
}

export function attribute(node: Element, name: string): string {
  const value = node.getAttribute(name);
  if (!value) throw authenticationFailed();
  return value;
}

export function xmlText(node: Element): string {
  if (elements(node).length) throw authenticationFailed();
  const value = node.textContent ?? '';
  if (!value.length || value.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw authenticationFailed();
  return value;
}

export function xmlId(node: Element): string {
  const id = attribute(node, 'ID');
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(id)) throw authenticationFailed();
  return id;
}

/** Refuse DTDs/entities, comments, CDATA and PIs before either XML parser sees them. */
export function parseBoundedXml(xml: string): Document & { documentElement: Element } {
  if (new TextEncoder().encode(xml).byteLength > SAML_XML_BYTES || /<!/i.test(xml)
    || /<\?(?!xml(?:\s|\?>))/i.test(xml) || /\x00/.test(xml)) throw authenticationFailed();
  let document: Document;
  try {
    document = new DOMParser({ onError: () => { throw new Error('Invalid XML'); } }).parseFromString(xml, 'application/xml');
  } catch { throw authenticationFailed(); }
  if (!document.documentElement || document.doctype || elements(document).length !== 1) throw authenticationFailed();
  const queue: { node: Element; depth: number }[] = [{ node: document.documentElement, depth: 1 }];
  const ids = new Set<string>();
  let nodes = 0;
  while (queue.length) {
    const { node, depth } = queue.pop()!;
    if (++nodes > 2048 || depth > 32 || node.attributes.length > 32) throw authenticationFailed();
    for (let index = 0; index < node.attributes.length; index++) {
      const attr = node.attributes.item(index)!;
      if (attr.value.length > 8192 || attr.name === 'xml:base') throw authenticationFailed();
      if (attr.localName?.toLowerCase() === 'id') {
        if (attr.namespaceURI || ids.has(attr.value) || !/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(attr.value)) throw authenticationFailed();
        ids.add(attr.value);
      }
    }
    for (const nested of elements(node)) queue.push({ node: nested, depth: depth + 1 });
  }
  return document as Document & { documentElement: Element };
}

export function validateSigningCertificate(pem: string): X509Certificate {
  try {
    if (pem.length > 16_384 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(pem)) throw new Error('PEM certificate required');
    const certificate = new X509Certificate(pem);
    if (certificate.publicKey.asymmetricKeyType !== 'rsa' || (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Certificate unusable');
    return certificate;
  } catch { throw new ApiError(422, 'saml_certificate_invalid', 'Use a currently valid RSA signing certificate with a key of at least 2048 bits.'); }
}

function validateSignatureProfile(signature: Element, parent: Element): void {
  const info = child(signature, SIGNATURE_NS, 'SignedInfo');
  onlySignatureChildren(info, ['CanonicalizationMethod', 'SignatureMethod', 'Reference']);
  if (!canonicalizationMethods.has(attribute(child(info, SIGNATURE_NS, 'CanonicalizationMethod'), 'Algorithm'))
    || !signatureMethods.has(attribute(child(info, SIGNATURE_NS, 'SignatureMethod'), 'Algorithm'))) throw authenticationFailed();
  const reference = child(info, SIGNATURE_NS, 'Reference');
  onlySignatureChildren(reference, ['Transforms', 'DigestMethod', 'DigestValue']);
  if (attribute(reference, 'URI') !== `#${xmlId(parent)}` || !digestMethods.has(attribute(child(reference, SIGNATURE_NS, 'DigestMethod'), 'Algorithm'))) throw authenticationFailed();
  const transforms = elements(child(reference, SIGNATURE_NS, 'Transforms'));
  if (transforms.length !== 2 || transforms[0]!.getAttribute('Algorithm') !== `${SIGNATURE_NS}enveloped-signature`
    || transforms.some(item => item.namespaceURI !== SIGNATURE_NS || item.localName !== 'Transform')
    || !canonicalizationMethods.has(attribute(transforms[1]!, 'Algorithm'))) throw authenticationFailed();
  if (elements(transforms[0]!).length || elements(transforms[1]!).some(item => item.namespaceURI !== C14N || item.localName !== 'InclusiveNamespaces')) throw authenticationFailed();
  if (elements(signature).some(item => !['SignedInfo', 'SignatureValue', 'KeyInfo'].includes(item.localName!) || item.namespaceURI !== SIGNATURE_NS)) throw authenticationFailed();
  if (elements(signature, SIGNATURE_NS, 'KeyInfo').length > 1) throw authenticationFailed();
  if (elements(child(info, SIGNATURE_NS, 'SignatureMethod')).length || elements(child(reference, SIGNATURE_NS, 'DigestMethod')).length) throw authenticationFailed();
  xmlText(child(reference, SIGNATURE_NS, 'DigestValue'));
  xmlText(child(signature, SIGNATURE_NS, 'SignatureValue'));
}

function onlySignatureChildren(node: Element, names: string[]): void {
  const children = elements(node);
  if (children.length !== names.length || children.some(item => item.namespaceURI !== SIGNATURE_NS || !names.includes(item.localName!))) throw authenticationFailed();
  for (const name of names) child(node, SIGNATURE_NS, name);
}

/**
 * xml-crypto performs all XMLDSIG/canonicalization/reference digest/signature verification.
 * Only getSignedReferences() output is used for claims. The input DOM is never authentication evidence.
 */
export function verifiedElement(xml: string, parent: Element, certificates: string[]): Element {
  const signature = child(parent, SIGNATURE_NS, 'Signature');
  validateSignatureProfile(signature, parent);
  const signatureXml = new XMLSerializer().serializeToString(signature);
  for (const pem of certificates) {
    let certificate: X509Certificate;
    try { certificate = validateSigningCertificate(pem); }
    catch { continue; } // Expired rollover keys do not invalidate a different, current pinned key.
    // ID is already one of xml-crypto's built-in ID attributes. Adding it again
    // would make its duplicate-reference defense count the same element twice.
    const verifier = new SignedXml({ publicCert: certificate.toString(), getCertFromKeyInfo: () => null });
    try {
      verifier.loadSignature(signatureXml);
      if (!verifier.checkSignature(xml)) continue;
      const references = verifier.getSignedReferences();
      if (references.length !== 1) throw authenticationFailed();
      const verified = parseBoundedXml(references[0]!).documentElement;
      if (verified.namespaceURI !== parent.namespaceURI || verified.localName !== parent.localName || xmlId(verified) !== xmlId(parent)) throw authenticationFailed();
      return verified;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Key rollover may legitimately require trying the next pinned certificate.
    }
  }
  throw authenticationFailed();
}

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function samlTimestamp(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) throw authenticationFailed();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 19) !== value.slice(0, 19)) throw authenticationFailed();
  return result;
}
