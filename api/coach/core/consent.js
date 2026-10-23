export const CONSENT_VERSION = 2;
export const hasCoachConsent = S => !!S?.coach?.consent?.agreedAt && S.coach.consent.version === CONSENT_VERSION;
