// OAuth utilities for cookie-based approval and upstream OAuth flows

import type { 
  AuthRequest, 
  ClientInfo,
  ApprovalDialogOptions,
  ParsedApprovalResult,
  UpstreamAuthorizeParams,
  UpstreamTokenParams 
} from "../types";

const COOKIE_NAME = "mcp-approved-clients";
const NINETY_DAYS_IN_SECONDS = 7776000; // 90 days - shorter for security

// --- Helper Functions ---

/**
 * Encodes a string to URL-safe base64.
 * @param data - The string to encode.
 * @returns A URL-safe base64 encoded string.
 */
function urlSafeBase64Encode(data: string): string {
	const base64 = btoa(data);
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes a URL-safe base64 string (backward compatible with standard base64).
 * @param encoded - The URL-safe base64 encoded string.
 * @returns The decoded string.
 */
function urlSafeBase64Decode(encoded: string): string {
	let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
	while (base64.length % 4) {
		base64 += '=';
	}
	return atob(base64);
}

/**
 * Encodes arbitrary data to a URL-safe base64 string.
 * @param data - The data to encode (will be stringified).
 * @returns A URL-safe base64 encoded string.
 */
function encodeState(data: unknown): string {
	try {
		const jsonString = JSON.stringify(data);
		const utf8Bytes = new TextEncoder().encode(jsonString);
		// Chunked conversion to avoid call stack limits with large data
		let binaryString = '';
		const chunkSize = 8192;
		for (let i = 0; i < utf8Bytes.length; i += chunkSize) {
			const chunk = utf8Bytes.subarray(i, i + chunkSize);
			binaryString += String.fromCharCode(...chunk);
		}
		const base64 = btoa(binaryString);
		// Make URL-safe by replacing +, /, and removing =
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	} catch (e) {
		console.error("Error encoding state:", e);
		throw new Error("Could not encode state");
	}
}

/**
 * Signs state data using HMAC-SHA256 and returns a signed token.
 * Format: signature.encodedPayload
 * @param data - The state data to sign.
 * @param secret - The secret key for signing.
 * @returns A promise resolving to the signed state token.
 */
export async function signState(data: unknown, secret: string): Promise<string> {
	const encoded = encodeState(data);
	const key = await importKey(secret);
	const signature = await signData(key, encoded);
	return `${signature}.${encoded}`;
}

/**
 * Verifies and decodes a signed state token.
 * @param signedState - The signed state token (signature.encodedPayload).
 * @param secret - The secret key for verification.
 * @returns A promise resolving to the decoded state data.
 * @throws If signature verification fails or state is malformed.
 */
export async function verifyAndDecodeState<T = unknown>(signedState: string, secret: string): Promise<T> {
	const parts = signedState.split('.');
	if (parts.length !== 2) {
		throw new Error('Invalid state format');
	}

	const [signatureHex, encoded] = parts;
	const key = await importKey(secret);
	const isValid = await verifySignature(key, signatureHex, encoded);

	if (!isValid) {
		throw new Error('State signature verification failed');
	}

	return decodeState<T>(encoded);
}

/**
 * Decodes a URL-safe base64 string back to its original data.
 * @param encoded - The URL-safe base64 encoded string.
 * @returns The original data.
 */
function decodeState<T = any>(encoded: string): T {
	try {
		// Reverse URL-safe encoding (- to +, _ to /, add padding)
		let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
		// Add padding if needed
		while (base64.length % 4) {
			base64 += '=';
		}
		// Decode base64 then UTF-8
		const binaryString = atob(base64);
		const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
		const jsonString = new TextDecoder().decode(bytes);
		return JSON.parse(jsonString);
	} catch (e) {
		console.error("Error decoding state:", e);
		throw new Error("Could not decode state");
	}
}

/**
 * Imports a secret key string for HMAC-SHA256 signing.
 * @param secret - The raw secret key string.
 * @returns A promise resolving to the CryptoKey object.
 */
async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error(
			"COOKIE_SECRET is not defined. A secret key is required for signing cookies.",
		);
	}
	const enc = new TextEncoder();
	const secretBytes = enc.encode(secret);
	if (secretBytes.length < 32) {
		throw new Error(
			"COOKIE_SECRET must be at least 32 characters for secure HMAC-SHA256 signing.",
		);
	}
	return crypto.subtle.importKey(
		"raw",
		secretBytes,
		{ hash: "SHA-256", name: "HMAC" },
		false, // not extractable
		["sign", "verify"], // key usages
	);
}

/**
 * Signs data using HMAC-SHA256.
 * @param key - The CryptoKey for signing.
 * @param data - The string data to sign.
 * @returns A promise resolving to the signature as a hex string.
 */
async function signData(key: CryptoKey, data: string): Promise<string> {
	const enc = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	// Convert ArrayBuffer to hex string
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Verifies an HMAC-SHA256 signature.
 * @param key - The CryptoKey for verification.
 * @param signatureHex - The signature to verify (hex string).
 * @param data - The original data that was signed.
 * @returns A promise resolving to true if the signature is valid, false otherwise.
 */
async function verifySignature(
	key: CryptoKey,
	signatureHex: string,
	data: string,
): Promise<boolean> {
	const enc = new TextEncoder();
	try {
		// Validate hex format before parsing (prevents NaN→0 conversion attack)
		if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length !== 64) {
			console.error("Invalid signature format");
			return false;
		}
		// Convert hex signature back to ArrayBuffer
		const hexPairs = signatureHex.match(/.{1,2}/g);
		if (!hexPairs) {
			console.error("Invalid hex signature format");
			return false;
		}
		const signatureBytes = new Uint8Array(
			hexPairs.map((byte) => Number.parseInt(byte, 16)),
		);
		return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer, enc.encode(data));
	} catch (e) {
		// Handle errors during hex parsing or verification
		console.error("Error verifying signature:", e);
		return false;
	}
}

/**
 * Parses the signed cookie and verifies its integrity.
 * @param cookieHeader - The value of the Cookie header from the request.
 * @param secret - The secret key used for signing.
 * @returns A promise resolving to the list of approved client IDs if the cookie is valid, otherwise null.
 */
async function getApprovedClientsFromCookie(
	cookieHeader: string | null,
	secret: string,
): Promise<string[] | null> {
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const targetCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));

	if (!targetCookie) return null;

	const cookieValue = targetCookie.substring(COOKIE_NAME.length + 1);
	const parts = cookieValue.split(".");

	if (parts.length !== 2) {
		console.warn("Invalid cookie format received.");
		return null; // Invalid format
	}

	const [signatureHex, base64Payload] = parts;
	let payload: string;
	try {
		payload = urlSafeBase64Decode(base64Payload);
	} catch {
		console.warn("Invalid base64 in cookie payload.");
		return null;
	}

	const key = await importKey(secret);
	const isValid = await verifySignature(key, signatureHex, payload);

	if (!isValid) {
		console.warn("Cookie signature verification failed.");
		return null; // Signature invalid
	}

	try {
		const approvedClients = JSON.parse(payload);
		if (!Array.isArray(approvedClients)) {
			console.warn("Cookie payload is not an array.");
			return null; // Payload isn't an array
		}
		// Ensure all elements are strings
		if (!approvedClients.every((item) => typeof item === "string")) {
			console.warn("Cookie payload contains non-string elements.");
			return null;
		}
		return approvedClients as string[];
	} catch (e) {
		console.error("Error parsing cookie payload:", e);
		return null; // JSON parsing failed
	}
}

// --- Exported Functions ---

/**
 * Checks if a given client ID has already been approved by the user,
 * based on a signed cookie.
 *
 * @param request - The incoming Request object to read cookies from.
 * @param clientId - The OAuth client ID to check approval for.
 * @param cookieSecret - The secret key used to sign/verify the approval cookie.
 * @returns A promise resolving to true if the client ID is in the list of approved clients in a valid cookie, false otherwise.
 */
export async function clientIdAlreadyApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	if (!clientId) return false;
	const cookieHeader = request.headers.get("Cookie");
	const approvedClients = await getApprovedClientsFromCookie(cookieHeader, cookieSecret);

	return approvedClients?.includes(clientId) ?? false;
}


/**
 * Renders an approval dialog for OAuth authorization
 * The dialog displays information about the client and server
 * and includes a form to submit approval
 *
 * @param request - The HTTP request
 * @param options - Configuration for the approval dialog
 * @param secret - The secret key for signing state
 * @returns A Response containing the HTML approval dialog
 */
export async function renderApprovalDialog(request: Request, options: ApprovalDialogOptions, secret: string): Promise<Response> {
	const { client, server, state } = options;

	// Sign state for form submission
	const encodedState = await signState(state, secret);

	// Sanitize any untrusted content
	const serverName = sanitizeHtml(server.name);
	const clientName = client?.clientName ? sanitizeHtml(client.clientName) : "Unknown MCP Client";
	const serverDescription = server.description ? sanitizeHtml(server.description) : "";

	// URL validation helper with SSRF protection
	// Note: DNS rebinding (domains resolving to private IPs) cannot be prevented at
	// URL validation time without DNS resolution, which introduces TOCTOU race conditions.
	function isValidHttpUrl(urlString: string): boolean {
		try {
			const url = new URL(urlString);
			// Validate protocol
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return false;
			}
			// Block URLs with embedded credentials
			if (url.username || url.password) {
				return false;
			}
			const hostname = url.hostname.toLowerCase();
			// Block alternative IP representations (decimal, octal, hex) that bypass hostname checks
			if (/^\d+$/.test(hostname) || /^0[0-7]+\./.test(hostname) || /^0x[0-9a-f]+\./i.test(hostname)) {
				return false;
			}
			// Block localhost and loopback (full 127.0.0.0/8 range, not just 127.0.0.1)
			if (hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0') {
				return false;
			}
			// Block IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
			if (/^::ffff:127\.|^::ffff:10\.|^::ffff:192\.168\.|^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) {
				return false;
			}
			// Block private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
			if (/^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\./.test(hostname)) {
				return false;
			}
			// Block link-local and cloud metadata endpoints
			if (/^169\.254\.|^fe80:/i.test(hostname)) {
				return false;
			}
			// Block IPv6 Unique Local Addresses (fc00::/7 - commonly fd00::/8)
			if (/^(fc|fd)[0-9a-f]{0,2}:/i.test(hostname)) {
				return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	// Safe URLs with protocol validation
	const logoUrl = server.logo && isValidHttpUrl(server.logo) ? sanitizeHtml(server.logo) : "";
	const clientUri = client?.clientUri && isValidHttpUrl(client.clientUri) ? sanitizeHtml(client.clientUri) : "";
	const policyUri = client?.policyUri && isValidHttpUrl(client.policyUri) ? sanitizeHtml(client.policyUri) : "";
	const tosUri = client?.tosUri && isValidHttpUrl(client.tosUri) ? sanitizeHtml(client.tosUri) : "";

	// Client contacts
	const contacts =
		client?.contacts && client.contacts.length > 0
			? sanitizeHtml(client.contacts.join(", "))
			: "";

	// Get redirect URIs
	const redirectUris =
		client?.redirectUris && client.redirectUris.length > 0
			? client.redirectUris.map((uri) => sanitizeHtml(uri))
			: [];

	// Generate HTML for the approval dialog
	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          /* Modern, responsive styling with system fonts */
          :root {
            --primary-color: #0070f3;
            --error-color: #f44336;
            --border-color: #e5e7eb;
            --text-color: #333;
            --background-color: #fff;
            --card-shadow: 0 8px 36px 8px rgba(0, 0, 0, 0.1);
          }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, 
                         Helvetica, Arial, sans-serif, "Apple Color Emoji", 
                         "Segoe UI Emoji", "Segoe UI Symbol";
            line-height: 1.6;
            color: var(--text-color);
            background-color: #f9fafb;
            margin: 0;
            padding: 0;
          }
          
          .container {
            max-width: 600px;
            margin: 2rem auto;
            padding: 1rem;
          }
          
          .precard {
            padding: 2rem;
            text-align: center;
          }
          
          .card {
            background-color: var(--background-color);
            border-radius: 8px;
            box-shadow: var(--card-shadow);
            padding: 2rem;
          }
          
          .header {
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 1.5rem;
          }
          
          .logo {
            width: 48px;
            height: 48px;
            margin-right: 1rem;
            border-radius: 8px;
            object-fit: contain;
          }
          
          .title {
            margin: 0;
            font-size: 1.3rem;
            font-weight: 400;
          }
          
          .alert {
            margin: 0;
            font-size: 1.5rem;
            font-weight: 400;
            margin: 1rem 0;
            text-align: center;
          }
          
          .description {
            color: #555;
          }
          
          .client-info {
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 1rem 1rem 0.5rem;
            margin-bottom: 1.5rem;
          }
          
          .client-name {
            font-weight: 600;
            font-size: 1.2rem;
            margin: 0 0 0.5rem 0;
          }
          
          .client-detail {
            display: flex;
            margin-bottom: 0.5rem;
            align-items: baseline;
          }
          
          .detail-label {
            font-weight: 500;
            min-width: 120px;
          }
          
          .detail-value {
            font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            word-break: break-all;
          }
          
          .detail-value a {
            color: inherit;
            text-decoration: underline;
          }
          
          .detail-value.small {
            font-size: 0.8em;
          }
          
          .external-link-icon {
            font-size: 0.75em;
            margin-left: 0.25rem;
            vertical-align: super;
          }
          
          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 1rem;
            margin-top: 2rem;
          }
          
          .button {
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-size: 1rem;
          }
          
          .button-primary {
            background-color: var(--primary-color);
            color: white;
          }
          
          .button-secondary {
            background-color: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-color);
          }
          
          /* Responsive adjustments */
          @media (max-width: 640px) {
            .container {
              margin: 1rem auto;
              padding: 0.5rem;
            }
            
            .card {
              padding: 1.5rem;
            }
            
            .client-detail {
              flex-direction: column;
            }
            
            .detail-label {
              min-width: unset;
              margin-bottom: 0.25rem;
            }
            
            .actions {
              flex-direction: column;
            }
            
            .button {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="precard">
            <div class="header">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ""}
            <h1 class="title"><strong>${serverName}</strong></h1>
            </div>
            
            ${serverDescription ? `<p class="description">${serverDescription}</p>` : ""}
          </div>
            
          <div class="card">
            
            <h2 class="alert"><strong>${clientName || "A new MCP Client"}</strong> is requesting access</h2>
            
            <div class="client-info">
              <div class="client-detail">
                <div class="detail-label">Name:</div>
                <div class="detail-value">
                  ${clientName}
                </div>
              </div>
              
              ${
					clientUri
						? `
                <div class="client-detail">
                  <div class="detail-label">Website:</div>
                  <div class="detail-value small">
                    <a href="${clientUri}" target="_blank" rel="noopener noreferrer">
                      ${clientUri}
                    </a>
                  </div>
                </div>
              `
						: ""
				}
              
              ${
					policyUri
						? `
                <div class="client-detail">
                  <div class="detail-label">Privacy Policy:</div>
                  <div class="detail-value">
                    <a href="${policyUri}" target="_blank" rel="noopener noreferrer">
                      ${policyUri}
                    </a>
                  </div>
                </div>
              `
						: ""
				}
              
              ${
					tosUri
						? `
                <div class="client-detail">
                  <div class="detail-label">Terms of Service:</div>
                  <div class="detail-value">
                    <a href="${tosUri}" target="_blank" rel="noopener noreferrer">
                      ${tosUri}
                    </a>
                  </div>
                </div>
              `
						: ""
				}
              
              ${
					redirectUris.length > 0
						? `
                <div class="client-detail">
                  <div class="detail-label">Redirect URIs:</div>
                  <div class="detail-value small">
                    ${redirectUris.map((uri) => `<div>${uri}</div>`).join("")}
                  </div>
                </div>
              `
						: ""
				}
              
              ${
					contacts
						? `
                <div class="client-detail">
                  <div class="detail-label">Contact:</div>
                  <div class="detail-value">${contacts}</div>
                </div>
              `
						: ""
				}
            </div>
            
            <p>This MCP Client is requesting to be authorized on ${serverName}. If you approve, you will be redirected to complete authentication.</p>
            
            <form method="post" action="${new URL(request.url).pathname}">
              <input type="hidden" name="state" value="${encodedState}">
              
              <div class="actions">
                <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-primary">Approve</button>
              </div>
            </form>
          </div>
        </div>
      </body>
    </html>
  `;

	return new Response(htmlContent, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
		},
	});
}


/**
 * Parses the form submission from the approval dialog, extracts the state,
 * and generates Set-Cookie headers to mark the client as approved.
 *
 * @param request - The incoming POST Request object containing the form data.
 * @param cookieSecret - The secret key used to sign the approval cookie.
 * @returns A promise resolving to an object containing the parsed state and necessary headers.
 * @throws If the request method is not POST, form data is invalid, or state is missing.
 */
export async function parseRedirectApproval(
	request: Request,
	cookieSecret: string,
): Promise<ParsedApprovalResult> {
	if (request.method !== "POST") {
		throw new Error("Invalid request method. Expected POST.");
	}

	let state: { oauthReqInfo?: AuthRequest } | undefined;
	let clientId: string | undefined;

	try {
		const formData = await request.formData();
		const signedState = formData.get("state");

		if (typeof signedState !== "string" || !signedState) {
			throw new Error("Missing or invalid 'state' in form data.");
		}

		// Verify signature and decode the state
		state = await verifyAndDecodeState<{ oauthReqInfo?: AuthRequest }>(signedState, cookieSecret);
		clientId = state?.oauthReqInfo?.clientId; // Extract clientId from within the state

		if (!clientId) {
			throw new Error("Could not extract clientId from state object.");
		}
	} catch (e) {
		console.error("Error processing form submission:", e);
		// Rethrow or handle as appropriate, maybe return a specific error response
		throw new Error(
			`Failed to parse approval form: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// Get existing approved clients
	const cookieHeader = request.headers.get("Cookie");
	const existingApprovedClients =
		(await getApprovedClientsFromCookie(cookieHeader, cookieSecret)) || [];

	// Add the newly approved client ID (avoid duplicates)
	const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, clientId]));

	// Sign the updated list
	const payload = JSON.stringify(updatedApprovedClients);
	const key = await importKey(cookieSecret);
	const signature = await signData(key, payload);
	const newCookieValue = `${signature}.${urlSafeBase64Encode(payload)}`;

	// Generate Set-Cookie header
	const headers: Record<string, string> = {
		"Set-Cookie": `${COOKIE_NAME}=${newCookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${NINETY_DAYS_IN_SECONDS}`,
	};

	return { headers, state };
}

/**
 * Sanitizes HTML content to prevent XSS attacks
 * @param unsafe - The unsafe string that might contain HTML
 * @returns A safe string with HTML special characters escaped
 */
function sanitizeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// --- OAuth Helper Functions ---

/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {UpstreamAuthorizeParams} options - The parameters for constructing the URL
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: UpstreamAuthorizeParams): string {
	if (!state) {
		throw new Error("State parameter is required for CSRF protection");
	}
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

/**
 * Fetches an authorization token from an upstream service.
 *
 * @param {UpstreamTokenParams} options - The parameters for the token exchange
 * @returns {Promise<[string, null] | [null, Response]>} A promise that resolves to an array containing the access token or an error response.
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: UpstreamTokenParams): Promise<[string, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	// Add timeout to prevent indefinite hanging
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

	let resp: Response;
	try {
		resp = await fetch(upstream_url, {
			body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Accept": "application/json, application/x-www-form-urlencoded",
			},
			method: "POST",
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			console.error('Token exchange timed out');
			return [null, new Response("Token exchange timed out", { status: 504 })];
		}
		// Handle network errors without crashing the worker
		console.error('Token exchange failed:', error instanceof Error ? error.message : String(error));
		return [null, new Response("Token exchange failed", { status: 502 })];
	} finally {
		clearTimeout(timeoutId);
	}

	if (!resp.ok) {
		console.error('Failed to fetch access token:', resp.status, resp.statusText);
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}

	// Handle both JSON and form-encoded responses
	const contentType = resp.headers.get("Content-Type") || "";
	let accessToken: string | null = null;

	try {
		if (contentType.includes("application/json")) {
			const json = await resp.json();
			accessToken = typeof json.access_token === "string" ? json.access_token : null;
		} else {
			// Use text + URLSearchParams for robust parsing of form-encoded responses
			const body = await resp.text();
			const params = new URLSearchParams(body);
			accessToken = params.get("access_token");
		}
	} catch (error) {
		console.error("Failed to parse token response:", error);
		return [null, new Response("Invalid token response format", { status: 500 })];
	}

	if (!accessToken) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [accessToken, null];
}
