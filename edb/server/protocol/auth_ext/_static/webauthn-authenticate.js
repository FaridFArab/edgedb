import {
  decodeBase64Url,
  encodeBase64Url,
  parseResponseAsJSON,
} from "./utils.js";

document.addEventListener("DOMContentLoaded", () => {
  /** @type {HTMLFormElement | null} */
  const authenticateForm = document.getElementById("email-factor");

  if (authenticateForm === null) {
    return;
  }

  authenticateForm.addEventListener("submit", async (event) => {
    if (event.submitter?.id !== "webauthn-signin") {
      return;
    }
    event.preventDefault();

    const formData = new FormData(
      /** @type {HTMLFormElement} */ authenticateForm
    );
    const email = formData.get("email");
    const provider = "builtin::local_webauthn";
    const challenge = formData.get("challenge");
    const redirectOnFailure = formData.get("redirect_on_failure");
    const redirectTo = formData.get("redirect_to");

    if (redirectTo === null) {
      throw new Error("Missing redirect_to parameter");
    }

    try {
      const maybeCode = await authenticate({
        email,
        provider,
        challenge,
      });

      const redirectUrl = new URL(redirectTo);
      if (maybeCode !== null) {
        redirectUrl.searchParams.append("code", maybeCode);
      }

      window.location.href = redirectUrl.href;
    } catch (error) {
      console.error("Failed to register WebAuthn credentials:", error);
      const url = new URL(redirectOnFailure ?? redirectTo);
      url.searchParams.append("error", error.message);
      window.location.href = url.href;
    }
  });
});

const WEBAUTHN_OPTIONS_URL = new URL(
  "../webauthn/authenticate/options",
  window.location
);
const WEBAUTHN_AUTHENTICATE_URL = new URL(
  "../webauthn/authenticate",
  window.location
);
/**
 * Authenticate an existing WebAuthn credential for the given email address
 * @param {Object} props - The properties for registration
 * @param {string} props.email - Email address to register
 * @param {string} props.provider - WebAuthn provider
 * @param {string} props.challenge - PKCE challenge
 * @returns {Promise<string | null>} - The PKCE code or null if the application
 *   requires email verification
 */
export async function authenticate({ email, provider, challenge }) {
  // Check if WebAuthn is supported
  if (!window.PublicKeyCredential) {
    console.error("WebAuthn is not supported in this browser.");
    return;
  }

  // Fetch WebAuthn options from the server
  const options = await getAuthenticateOptions(email);

  // Get the existing credentials assertion
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: decodeBase64Url(options.challenge),
      allowCredentials: options.allowCredentials.map((credential) => ({
        ...credential,
        id: decodeBase64Url(credential.id),
      })),
    },
  });

  // Register the credentials on the server
  const registerResult = await authenticateAssertion({
    email,
    assertion,
    challenge,
  });

  return registerResult.code ?? null;
}

/**
 * Fetch WebAuthn options from the server
 * @param {string} email - Email address to register
 * @returns {Promise<globalThis.PublicKeyCredentialCreationOptions>}
 */
async function getAuthenticateOptions(email) {
  const url = new URL(WEBAUTHN_OPTIONS_URL);
  url.searchParams.set("email", email);

  const optionsResponse = await fetch(url, {
    method: "GET",
  });

  if (!optionsResponse.ok) {
    console.error(
      "Failed to fetch WebAuthn options:",
      optionsResponse.statusText
    );
    console.error(await optionsResponse.text());
    throw new Error("Failed to fetch WebAuthn options");
  }

  try {
    return await optionsResponse.json();
  } catch (e) {
    console.error("Failed to parse WebAuthn options:", e);
    throw new Error("Failed to parse WebAuthn options");
  }
}

/**
 * Authenticate the credentials on the server
 * @param {Object} props
 * @param {string} props.email
 * @param {Object} props.assertion
 * @param {string} props.provider
 * @param {string} props.challenge
 * @returns {Promise<Object>}
 */
async function authenticateAssertion(props) {
  // Assertion includes raw bytes, so need to be encoded as base64url
  // for transmission
  const encodedAssertion = {
    ...props.assertion,
    rawId: encodeBase64Url(new Uint8Array(props.assertion.rawId)),
    response: {
      ...props.assertion.response,
      authenticatorData: encodeBase64Url(
        new Uint8Array(props.assertion.response.authenticatorData)
      ),
      clientDataJSON: encodeBase64Url(
        new Uint8Array(props.assertion.response.clientDataJSON)
      ),
      signature: encodeBase64Url(
        new Uint8Array(props.assertion.response.signature)
      ),
      userHandle: props.assertion.response.userHandle
        ? encodeBase64Url(new Uint8Array(props.assertion.response.userHandle))
        : null,
    },
  };

  const authenticateResponse = await fetch(WEBAUTHN_AUTHENTICATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: props.email,
      assertion: encodedAssertion,
      provider: props.provider,
      challenge: props.challenge,
    }),
  });

  return await parseResponseAsJSON(authenticateResponse, [
    (response, error) => {
      if (response.status === 401 && error?.type === "VerificationRequired") {
        console.error(
          "User's email is not verified",
          response.statusText,
          JSON.stringify(error)
        );
        throw new Error(
          "Please verify your email before attempting to sign in."
        );
      }
    },
    (response, error) => {
      console.error(
        "Failed to authenticate WebAuthn credentials:",
        response.statusText,
        JSON.stringify(error)
      );
      throw new Error("Failed to authenticate WebAuthn credentials");
    },
  ]);
}