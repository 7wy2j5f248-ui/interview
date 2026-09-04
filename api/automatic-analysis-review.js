export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(410).json({
        error: "The legacy automatic analytical reviewer, verifier, repair, and approval workflow has been removed. Historical provider output remains stored for researcher inspection."
    });
}
