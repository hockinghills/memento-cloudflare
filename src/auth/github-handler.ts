import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import type { Props, ExtendedEnv } from "../types";
import {
	clientIdAlreadyApproved,
	parseRedirectApproval,
	renderApprovalDialog,
	fetchUpstreamAuthToken,
	getUpstreamAuthorizeUrl,
	signState,
	verifyAndDecodeState,
} from "./oauth-utils";

const app = new Hono<{ Bindings: ExtendedEnv }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	if (
		await clientIdAlreadyApproved(c.req.raw, oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY)
	) {
		return redirectToGithub(c.req.raw, oauthReqInfo, c.env, {});
	}

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		server: {
			description: "Memento MCP Server - Knowledge graph memory with semantic search using Neo4j and VoyageAI embeddings",
			logo: "https://raw.githubusercontent.com/gannonh/memento-mcp/main/assets/memento-logo.svg",
			name: "Memento Knowledge Graph",
		},
		state: { oauthReqInfo },
	}, c.env.COOKIE_ENCRYPTION_KEY);
});

app.post("/authorize", async (c) => {
	const { state, headers } = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY);
	if (!state.oauthReqInfo) {
		return c.text("Invalid request", 400);
	}

	return redirectToGithub(c.req.raw, state.oauthReqInfo, c.env, headers);
});

async function redirectToGithub(
	request: Request,
	oauthReqInfo: AuthRequest,
	env: ExtendedEnv,
	headers: Record<string, string> = {},
) {
	// Sign the state to prevent tampering
	const signedState = await signState(oauthReqInfo, env.COOKIE_ENCRYPTION_KEY);

	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: env.OAUTH_CLIENT_ID,
				redirect_uri: new URL("/callback", request.url).href,
				scope: "read:user",
				state: signedState,
				upstream_url: "https://github.com/login/oauth/authorize",
			}),
		},
		status: 302,
	});
}

/**
 * OAuth Callback Endpoint
 *
 * Handles the callback from GitHub after user authentication.
 * Exchanges the code for an access token and stores user metadata.
 */
app.get("/callback", async (c) => {
	// Check for OAuth error response from GitHub
	const error = c.req.query("error");
	if (error) {
		const errorDesc = c.req.query("error_description") || "Authorization denied";
		console.error("GitHub OAuth error:", error, errorDesc);
		return c.text(`Authorization failed: ${errorDesc}`, 400);
	}

	let oauthReqInfo: AuthRequest;
	try {
		const stateParam = c.req.query("state");
		if (!stateParam) {
			return c.text("Missing state parameter", 400);
		}
		// Verify signature and decode state
		oauthReqInfo = await verifyAndDecodeState<AuthRequest>(stateParam, c.env.COOKIE_ENCRYPTION_KEY);
	} catch (error) {
		console.error("Failed to verify/decode state:", error);
		return c.text("Invalid state parameter", 400);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid state", 400);
	}

	// Verify code parameter exists
	const code = c.req.query("code");
	if (!code) {
		return c.text("Missing authorization code", 400);
	}

	// Exchange the code for an access token
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.OAUTH_CLIENT_ID,
		client_secret: c.env.OAUTH_CLIENT_SECRET,
		code,
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	// Fetch the user info from GitHub
	let login: string;
	let name: string;
	let email: string;
	try {
		const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
		if (!user.data) {
			return c.text("Failed to fetch user info", 500);
		}
		login = user.data.login;
		name = user.data.name || login;
		email = user.data.email || `${login}@users.noreply.github.com`;
	} catch (error) {
		console.error("Failed to fetch GitHub user:", error instanceof Error ? error.message : "Unknown error");
		return c.text("Failed to authenticate with GitHub", 500);
	}

	// Complete authorization with user props
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
		},
		props: {
			accessToken,
			email,
			login,
			name,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	return Response.redirect(redirectTo);
});

export { app as GitHubHandler };
