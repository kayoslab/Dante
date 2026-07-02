/** Browser-side WebAuthn ceremony helpers for passkey registration.
 *
 * Cognito's `StartWebAuthnRegistration` returns a
 * `CredentialCreationOptions` JSON object whose binary fields (challenge,
 * user.id, excludeCredentials[].id) are base64url strings. The DOM
 * `navigator.credentials.create()` call wants those as ArrayBuffers, and
 * `CompleteWebAuthnRegistration` wants the resulting credential serialized
 * back to base64url JSON. These helpers do that conversion by hand rather
 * than relying on `PublicKeyCredential.parseCreationOptionsFromJSON()` /
 * `.toJSON()` — those Level-3 methods have uneven support across the
 * device mix we care about (older Safari / Firefox), and the manual path
 * is predictable everywhere WebAuthn itself works.
 *
 * Client-only: every function here touches `window` / `navigator`. */

function base64urlToArrayBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** WebAuthn is available only in a secure context with a platform /
 * cross-platform authenticator. Callers gate the "Add passkey" button on
 * this so unsupported devices fall back to TOTP cleanly. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator?.credentials?.create === "function"
  );
}

type CognitoCreationOptions = {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{
    type: "public-key";
    id: string;
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
};

/** Run the full registration ceremony: decode Cognito's options, call the
 * authenticator, and serialize the attestation back to the JSON shape
 * `CompleteWebAuthnRegistration` expects. Throws on user cancellation or
 * an unsupported device — the caller maps that to a toast. */
export async function registerPasskey(
  rawOptions: unknown,
): Promise<Record<string, unknown>> {
  if (!isPasskeySupported()) {
    throw new Error("This device doesn't support passkeys.");
  }
  const options = rawOptions as CognitoCreationOptions;

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64urlToArrayBuffer(options.challenge),
    rp: options.rp,
    user: {
      id: base64urlToArrayBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    attestation: options.attestation,
    authenticatorSelection: options.authenticatorSelection,
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
      type: c.type,
      id: base64urlToArrayBuffer(c.id),
      transports: c.transports,
    })),
  };

  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("Passkey registration was cancelled.");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === "function"
      ? response.getTransports()
      : [];

  return {
    id: credential.id,
    rawId: arrayBufferToBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
      attestationObject: arrayBufferToBase64url(response.attestationObject),
      transports,
    },
  };
}
