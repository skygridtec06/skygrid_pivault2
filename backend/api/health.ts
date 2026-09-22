type VercelRequest = { method?: string };
type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

export default function handler(_request: VercelRequest, response: VercelResponse) {
  response.status(200).json({ status: "ok", service: "skygrid-pivault-backend" });
}
