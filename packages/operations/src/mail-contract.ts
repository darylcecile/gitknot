export const IDENTITY_MAIL_SCOPE = 'mail.prepare-identity';
export const IDENTITY_MAIL_PATH = '/internal/mail/prepare-identity';

export interface PreparedMail {
  to: string;
  subject: string;
  text: string;
  security?: boolean;
  headers?: Record<string, string>;
}

export interface IdentityMailPreparation {
  delivery_id: string;
  message: PreparedMail | null;
}

export const identityMailEvents: Readonly<Record<string, string>> = {
  'identity.email_verification_requested': 'verify_email',
  'identity.verification_requested': 'verify_email',
  'identity.password_recovery_requested': 'recover_password',
  'identity.recovery_requested': 'recover_password',
  'identity.email_change_requested': 'change_email',
};
