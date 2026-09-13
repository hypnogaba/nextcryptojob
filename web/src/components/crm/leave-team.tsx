import { leaveAction } from "@/app/company/(crm)/team/actions";
import { HINT } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { LAST_OWNER_TEXT } from "@/lib/crm/company";

/**
 * "Leave the team". На сторінці команди; для компанії не в стані active (закрита,
 * на перевірці, призупинена) команда закрита, тож те саме стоїть у налаштуваннях.
 * Останній власник живої компанії піти не може (для закритої правило не діє).
 */
export function LeaveTeam({
  companyId,
  companyName,
  blocked,
  from,
}: {
  companyId: string;
  companyName: string;
  /** Людина останній власник компанії, що не закрита. */
  blocked: boolean;
  from: "team" | "settings";
}) {
  return (
    <section aria-labelledby="leave-title" className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <h2 id="leave-title" className="display text-[1.75rem] leading-none">
        Leave the team
      </h2>
      {blocked ? (
        <p className={HINT}>{LAST_OWNER_TEXT}</p>
      ) : (
        <form action={leaveAction} className="grid gap-3">
          <input type="hidden" name="company_id" value={companyId} />
          <input type="hidden" name="from" value={from} />
          <p className={HINT}>You lose access to {companyName} right away. Your notes stay, signed Former member.</p>
          <Button type="submit" variant="destructive" className="h-11 w-full px-5 text-base sm:w-fit">
            Leave {companyName}
          </Button>
        </form>
      )}
    </section>
  );
}
