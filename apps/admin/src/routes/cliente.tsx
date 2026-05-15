import { useParams } from "react-router-dom";
import ClienteFicha from "../components/ClienteFicha";

export default function ClienteRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <p>Slug inválido.</p>;
  return <ClienteFicha slug={slug} />;
}
