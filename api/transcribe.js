import { v1 as speech } from "@google-cloud/speech";

function getSpeechClient() {
    const credentialsJson =
        process.env.GOOGLE_CLOUD_CREDENTIALS;

    if (!credentialsJson) {
        throw new Error(
            "GOOGLE_CLOUD_CREDENTIALS is not configured."
        );
    }

    const credentials = JSON.parse(credentialsJson);

    return new speech.SpeechClient({
        credentials,
        projectId: credentials.project_id
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
            audioBase64,
            languageCode = "en-US"
        } = req.body || {};

        if (!audioBase64) {
            return res.status(400).json({
                error: "No audio was provided."
            });
        }

        const client = getSpeechClient();

        const request = {
            audio: {
                content: audioBase64
            },
            config: {
                encoding: "WEBM_OPUS",
                languageCode,
                enableAutomaticPunctuation: true
            }
        };

        const [response] =
            await client.recognize(request);

        const transcript = (response.results || [])
            .map(result =>
                result.alternatives?.[0]?.transcript || ""
            )
            .filter(Boolean)
            .join(" ");

        return res.status(200).json({
            transcript
        });

    } catch (error) {
        console.error(
            "Google Speech-to-Text error:",
            error
        );

        return res.status(500).json({
            error: "Transcription failed."
        });
    }
}
