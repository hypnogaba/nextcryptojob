import { redirect } from "next/navigation";

// Раунд 5, п.11: "Company terms" злито в один пункт "Terms" (/terms, розділ #companies).
// Старі посилання з кабінету компанії й листів не ламаємо: редирект сюди й далі.
export default function CompanyTermsRedirect(): never {
  redirect("/terms#companies");
}
