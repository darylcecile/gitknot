import { deflateRawSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import type { Element } from '@xmldom/xmldom';
import { ApiError } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { identityClaims } from './claims.ts';
import { authenticationFailed } from './errors.ts';
import { federationEndpoint, trustedFederationOrigins } from './network.ts';
import { publicOrigins } from './store.ts';
import { CLOCK_SKEW_SECONDS, FLOW_SECONDS } from './types.ts';
import type { AuthenticationFlow, Provider, SamlConfig, VerifiedIdentity } from './types.ts';
import {
  attribute, child, elements, escapeXml, parseBoundedXml, RSA_SHA256, samlTimestamp, SAML_NS,
  SAML_PROTOCOL_NS, SAML_XML_BYTES, SIGNATURE_NS, verifiedElement, xmlId, xmlText,
} from './xml.ts';

const bearer = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const postBinding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

function samlConfig(provider: Provider): SamlConfig {
  if (provider.config.protocol !== 'saml') throw authenticationFailed();
  return provider.config;
}

export function samlUrls(env: Bindings, providerId: string): { entity_id: string; acs: string } {
  const api = publicOrigins(env).api;
  return { entity_id: `${api}/v1/auth/saml/${providerId}/metadata`, acs: `${api}/v1/auth/saml/${providerId}/acs` };
}

export function samlMetadata(env: Bindings, provider: Provider, certificate: string | null): string {
  const config = samlConfig(provider);
  const urls = samlUrls(env, provider.id);
  if (config.sign_authn_requests && !certificate) throw new ApiError(503, 'saml_signing_key_unavailable', 'The organization SAML signing key has not been configured.');
  const key = certificate ? `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${escapeXml(certificate.replace(/-----[^-]+-----|\s/g, ''))}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` : '';
  const attributes = [...new Set([config.tenant_claim, config.external_id_claim, config.email_claim, config.email_verified_claim, config.name_claim,
    config.mappings.role_claim, config.mappings.group_claim].filter((value): value is string => value !== null))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="${SIGNATURE_NS}" entityID="${escapeXml(urls.entity_id)}"><md:SPSSODescriptor protocolSupportEnumeration="${SAML_PROTOCOL_NS}" AuthnRequestsSigned="${config.sign_authn_requests}" WantAssertionsSigned="true">${key}<md:NameIDFormat>${escapeXml(config.name_id_format)}</md:NameIDFormat><md:AssertionConsumerService Binding="${postBinding}" Location="${escapeXml(urls.acs)}" index="0" isDefault="true"/><md:AttributeConsumingService index="0"><md:ServiceName xml:lang="en">GitKnot organization sign-in</md:ServiceName>${attributes.map(name => `<md:RequestedAttribute Name="${escapeXml(name)}" isRequired="${[config.tenant_claim, config.external_id_claim].includes(name)}"/>`).join('')}</md:AttributeConsumingService></md:SPSSODescriptor></md:EntityDescriptor>`;
}

export function samlRequestXml(env: Bindings, provider: Provider, flow: AuthenticationFlow): string {
  const config = samlConfig(provider);
  const urls = samlUrls(env, provider.id);
  const destination = federationEndpoint(config.sso_url, trustedFederationOrigins(env));
  if (!flow.saml_request_id) throw authenticationFailed();
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_NS}" ID="${escapeXml(flow.saml_request_id)}" Version="2.0" IssueInstant="${escapeXml(flow.created_at)}" Destination="${escapeXml(destination.href)}" AssertionConsumerServiceURL="${escapeXml(urls.acs)}" ProtocolBinding="${postBinding}" ForceAuthn="true"><saml:Issuer>${escapeXml(urls.entity_id)}</saml:Issuer><samlp:NameIDPolicy Format="${escapeXml(config.name_id_format)}" AllowCreate="true"/><samlp:RequestedAuthnContext Comparison="exact">${config.mfa_contexts.map(context => `<saml:AuthnContextClassRef>${escapeXml(context)}</saml:AuthnContextClassRef>`).join('')}</samlp:RequestedAuthnContext></samlp:AuthnRequest>`;
}

/** The broker signs this exact RFC 3986-encoded Redirect binding string. */
export function samlRedirectParameters(env: Bindings, provider: Provider, flow: AuthenticationFlow, state: string, signed: boolean): string {
  if (!/^[\w-]{43}$/.test(state)) throw authenticationFailed();
  const compressed = Buffer.from(deflateRawSync(Buffer.from(samlRequestXml(env, provider, flow), 'utf8'))).toString('base64');
  return `SAMLRequest=${encodeURIComponent(compressed)}&RelayState=${encodeURIComponent(state)}${signed ? `&SigAlg=${encodeURIComponent(RSA_SHA256)}` : ''}`;
}

export function samlRedirectUrl(env: Bindings, provider: Provider, parameters: string, signature?: string): string {
  const config = samlConfig(provider);
  const url = federationEndpoint(config.sso_url, trustedFederationOrigins(env));
  url.search = parameters + (signature ? `&Signature=${encodeURIComponent(signature)}` : '');
  if (url.href.length > 16_384) throw new ApiError(422, 'saml_request_too_large', 'The configured SAML authentication request is too large.');
  return url.href;
}

function decodeSamlResponse(value: string): string {
  if (value.length > Math.ceil(SAML_XML_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw authenticationFailed();
  try {
    const data = Uint8Array.from(atob(value), item => item.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n?/g, '\n');
  } catch { throw authenticationFailed(); }
}

function checkIssueInstant(node: Element, flow: AuthenticationFlow): number {
  if (attribute(node, 'Version') !== '2.0') throw authenticationFailed();
  const instant = samlTimestamp(attribute(node, 'IssueInstant'));
  const skew = CLOCK_SKEW_SECONDS * 1000;
  if (instant > Date.now() + skew || instant < Date.now() - FLOW_SECONDS * 1000 - skew
    || instant < Date.parse(flow.created_at) - skew) throw authenticationFailed();
  return instant;
}

function checkWindow(node: Element, requireNotBefore: boolean): number {
  const notBefore = node.getAttribute('NotBefore');
  if (requireNotBefore && !notBefore) throw authenticationFailed();
  const expiry = samlTimestamp(attribute(node, 'NotOnOrAfter'));
  const start = notBefore ? samlTimestamp(notBefore) : null;
  const skew = CLOCK_SKEW_SECONDS * 1000;
  if ((start !== null && (start > Date.now() + skew || start >= expiry)) || expiry <= Date.now() - skew
    || expiry > Date.now() + (FLOW_SECONDS + CLOCK_SKEW_SECONDS) * 1000) throw authenticationFailed();
  return expiry;
}

function verifyResponseEnvelope(response: Element, config: SamlConfig, flow: AuthenticationFlow, acs: string): void {
  if (response.namespaceURI !== SAML_PROTOCOL_NS || response.localName !== 'Response'
    || attribute(response, 'InResponseTo') !== flow.saml_request_id || attribute(response, 'Destination') !== acs
    || xmlText(child(response, SAML_NS, 'Issuer')) !== config.issuer) throw authenticationFailed();
  checkIssueInstant(response, flow);
  xmlId(response);
  const status = child(child(response, SAML_PROTOCOL_NS, 'Status'), SAML_PROTOCOL_NS, 'StatusCode');
  if (attribute(status, 'Value') !== 'urn:oasis:names:tc:SAML:2.0:status:Success' || elements(status).length) throw authenticationFailed();
}

function verifySubject(assertion: Element, config: SamlConfig, flow: AuthenticationFlow, urls: ReturnType<typeof samlUrls>): { subject: string; expiry: number } {
  const subject = child(assertion, SAML_NS, 'Subject');
  const name = child(subject, SAML_NS, 'NameID');
  if (attribute(name, 'Format') !== config.name_id_format || (name.hasAttribute('NameQualifier') && name.getAttribute('NameQualifier') !== config.issuer)
    || (name.hasAttribute('SPNameQualifier') && name.getAttribute('SPNameQualifier') !== urls.entity_id)) throw authenticationFailed();
  const value = xmlText(name);
  if (value.length > 512) throw authenticationFailed();
  const confirmation = child(subject, SAML_NS, 'SubjectConfirmation');
  const data = child(confirmation, SAML_NS, 'SubjectConfirmationData');
  if (attribute(confirmation, 'Method') !== bearer || attribute(data, 'Recipient') !== urls.acs
    || attribute(data, 'InResponseTo') !== flow.saml_request_id || elements(data).length) throw authenticationFailed();
  return { subject: value, expiry: checkWindow(data, false) };
}

function verifyConditions(assertion: Element, audience: string): number {
  const conditions = child(assertion, SAML_NS, 'Conditions');
  const expiry = checkWindow(conditions, true);
  if (elements(conditions).some(value => value.namespaceURI !== SAML_NS || !['AudienceRestriction', 'OneTimeUse'].includes(value.localName!))) throw authenticationFailed();
  const restrictions = elements(conditions, SAML_NS, 'AudienceRestriction');
  if (!restrictions.length || restrictions.length > 8 || restrictions.some(restriction => {
    const audiences = elements(restriction, SAML_NS, 'Audience');
    return audiences.length < 1 || audiences.length > 16 || !audiences.some(value => xmlText(value) === audience);
  })) throw authenticationFailed();
  return expiry;
}

function verifyAuthentication(assertion: Element, config: SamlConfig, flow: AuthenticationFlow): { authenticated_at: string; session_expires_at: string | null } {
  const statement = child(assertion, SAML_NS, 'AuthnStatement');
  const instant = samlTimestamp(attribute(statement, 'AuthnInstant'));
  if (instant > Date.now() + CLOCK_SKEW_SECONDS * 1000 || instant < Date.parse(flow.created_at) - CLOCK_SKEW_SECONDS * 1000
    || instant < Date.now() - (config.max_authentication_age_seconds + CLOCK_SKEW_SECONDS) * 1000) throw authenticationFailed();
  const context = xmlText(child(child(statement, SAML_NS, 'AuthnContext'), SAML_NS, 'AuthnContextClassRef'));
  if (!config.mfa_contexts.includes(context)) throw new ApiError(403, 'organization_mfa_required', 'The identity provider must attest a fresh approved multi-factor authentication.');
  const sessionExpiry = statement.getAttribute('SessionNotOnOrAfter');
  const expiry = sessionExpiry ? samlTimestamp(sessionExpiry) : null;
  if (expiry !== null && expiry <= Date.now()) throw authenticationFailed();
  return { authenticated_at: new Date(instant).toISOString(), session_expires_at: expiry === null ? null : new Date(expiry).toISOString() };
}

function assertionAttributes(assertion: Element, subject: string): Record<string, unknown> {
  const attributes: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  attributes.sub = subject;
  let count = 0;
  for (const statement of elements(assertion, SAML_NS, 'AttributeStatement')) {
    for (const item of elements(statement, SAML_NS, 'Attribute')) {
      if (++count > 64) throw authenticationFailed();
      const name = attribute(item, 'Name');
      if (name.length > 256 || Object.hasOwn(attributes, name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw authenticationFailed();
      const values = elements(item, SAML_NS, 'AttributeValue');
      if (values.length > 64) throw authenticationFailed();
      attributes[name] = values.length === 1 ? xmlText(values[0]!) : values.map(xmlText);
    }
  }
  return attributes;
}

export function verifySamlIdentity(env: Bindings, provider: Provider, flow: AuthenticationFlow, encodedResponse: string): VerifiedIdentity {
  const config = samlConfig(provider);
  const urls = samlUrls(env, provider.id);
  const xml = decodeSamlResponse(encodedResponse);
  const document = parseBoundedXml(xml);
  const received = document.documentElement;
  if (received.localName !== 'Response' || received.namespaceURI !== SAML_PROTOCOL_NS
    || document.getElementsByTagNameNS(SAML_NS, 'Assertion').length !== 1
    || document.getElementsByTagNameNS(SAML_NS, 'EncryptedAssertion').length !== 0) throw authenticationFailed();
  const rawAssertion = child(received, SAML_NS, 'Assertion');
  // Assertions must always be signed. A present response signature must also verify.
  const responseSigned = elements(received, SIGNATURE_NS, 'Signature').length > 0;
  if (config.response_signature_required && !responseSigned) throw authenticationFailed();
  const response = responseSigned ? verifiedElement(xml, received, config.signing_certificates) : received;
  verifyResponseEnvelope(response, config, flow, urls.acs);
  const assertion = verifiedElement(xml, rawAssertion, config.signing_certificates);
  if (xmlText(child(assertion, SAML_NS, 'Issuer')) !== config.issuer) throw authenticationFailed();
  const issueInstant = checkIssueInstant(assertion, flow);
  const subject = verifySubject(assertion, config, flow, urls);
  const conditionExpiry = verifyConditions(assertion, urls.entity_id);
  const replayExpiry = new Date(Math.max(subject.expiry, conditionExpiry, issueInstant + FLOW_SECONDS * 1000) + CLOCK_SKEW_SECONDS * 1000).toISOString();
  return {
    protocol: 'saml', issuer: config.issuer, subject: subject.subject, mfa: true,
    ...identityClaims(config, assertionAttributes(assertion, subject.subject)), ...verifyAuthentication(assertion, config, flow),
    replays: [{ kind: 'saml_assertion', value: xmlId(assertion), expires_at: replayExpiry },
      ...(responseSigned ? [{ kind: 'saml_response' as const, value: xmlId(response), expires_at: replayExpiry }] : [])],
  };
}
