import textToSpeech from "@google-cloud/text-to-speech";
import { getVercelOidcToken } from "@vercel/oidc";
import { ExternalAccountClient } from "google-auth-library";

function getTextToSpeechClient() {
    const GCP_PROJECT_ID =
        process.env.GCP_PROJECT_ID;

    const GCP_PROJECT_NUMBER =
        process.env.GCP_PROJECT_NUMBER;

    const GCP_SERVICE_ACCOUNT_EMAIL =
        process.env.GCP_SERVICE_ACCOUNT_EMAIL;

    const GCP_WORKLOAD_IDENTITY_POOL_ID =
        process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;

    const GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID =
        process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;

    if (
        !GCP_PROJECT_ID ||
        !GCP_PROJECT_NUMBER ||
        !GCP_SERVICE_ACCOUNT_EMAIL ||
        !GCP_WORKLOAD_IDENTITY_POOL_ID ||
        !GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
    ) {
        throw new Error(
            "Google Cloud OIDC environment variables are not fully configured."
        );
    }

    const GCP_AUDIENCE =
        `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}` +
        `/locations/global/workloadIdentityPools/${GCP_WORKLOAD_IDENTITY_POOL_ID}` +
        `/providers/${GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`;

    const authClient =
        ExternalAccountClient.fromJSON({
            type: "external_account",
            audience: GCP_AUDIENCE,
            subject_token_type:
                "urn:ietf:params:oauth:token-type:jwt",
            token_url:
                "https://sts.googleapis.com/v1/token",
            service_account_impersonation_url:
                `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
            subject_token_supplier: {
                getSubjectToken: () =>
                    getVercelOidcToken()
            }
        });

    if (!authClient) {
        throw new Error(
            "Unable to create Google Cloud authentication client."
        );
    }

    authClient.scopes = [
        "https://www.googleapis.com/auth/cloud-platform"
    ];

    return new textToSpeech.TextToSpeechClient({
        projectId: GCP_PROJECT_ID,
        authClient
    });
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        const {
            text,
            languageCode
        } = req.body || {};

        if (!text || !text.trim()) {
            return res.status(400).json({
                error: "No text was provided."
            });
        }

        if (!languageCode) {
            return res.status(400).json({
                error: "No language code was provided."
            });
        }

        const client =
            getTextToSpeechClient();

        const request = {
            input: {
                text
            },
            voice: {
                languageCode
            },
            audioConfig: {
                audioEncoding: "MP3"
            }
        };

        const [response] =
            await client.synthesizeSpeech(request);

        if (!response.audioContent) {
            throw new Error(
                "Google Text-to-Speech returned no audio."
            );
        }

        const audioBase64 =
            Buffer.from(
                response.audioContent
            ).toString("base64");

        return res.status(200).json({
            audioBase64,
            mimeType: "audio/mpeg"
        });

    } catch (error) {
        console.error(
            "Google Text-to-Speech error:",
            error
        );

        return res.status(500).json({
            error: "Speech playback failed."
        });
    }
}
