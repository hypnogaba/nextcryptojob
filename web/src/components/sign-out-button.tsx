import { signOutAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="outline" className="h-11 px-4 text-base">
        Sign out
      </Button>
    </form>
  );
}
