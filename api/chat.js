export default async function handler(req, res) {
  res.status(200).json({
    reply: "Hello! Your AI interview backend is working."
  });
}
