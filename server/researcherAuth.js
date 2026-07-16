import { createHash, timingSafeEqual } from "node:crypto";

function tokenDigest(value) {
    return createHash("sha256").update(value, "utf8").digest();
}

export function authorizeResearcher(req, configuredToken) {
    if (typeof configuredToken !== "string" || !configuredToken) {
        return {
            authorized: false,
            status: 500,
            error: "Server configuration is incomplete."
        };
    }

    const authorization = typeof req.headers?.authorization === "string"
        ? req.headers.authorization
        : "";
    const match = authorization.match(/^Bearer (.+)$/);

    if (!match) {
        return {
            authorized: false,
            status: 401,
            error: "Researcher authorization is required."
        };
    }

    const suppliedDigest = tokenDigest(match[1]);
    const configuredDigest = tokenDigest(configuredToken);
    const authorized = timingSafeEqual(suppliedDigest, configuredDigest);

    return authorized
        ? { authorized: true }
        : {
            authorized: false,
            status: 401,
            error: "Researcher authorization failed."
        };
}
