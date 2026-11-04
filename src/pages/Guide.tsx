import { Tab } from "../components/Tabs";
import { useT } from "../i18n";
import { ReportView } from "../lib/api";
import { GUIDE_STEPS, GuideTarget } from "../lib/guide-steps";
import { reportLabel } from "../lib/report-name";

interface Props {
  reportViews: ReportView[];
  onOpen: (tab: Tab) => void;
}

/// The monthly routine, for someone who comes back once a month and has
/// forgotten what comes next.
export function GuidePage({ reportViews, onOpen }: Props) {
  const t = useT();
  const report = reportViews[0];

  function openButton(target: GuideTarget) {
    if (target === "report" && !report) return null;
    const label = target === "report" ? reportLabel(report.name, t).label : t(`tabs.${target}`);
    return (
      <button
        type="button"
        className="btn-ghost guide-open"
        onClick={() => onOpen(target === "report" ? { kind: "report", id: report.id } : target)}
      >
        {t("guide.open", { screen: label })}
      </button>
    );
  }

  return (
    <section className="page page--guide">
      <div className="guide">
        <h2>{t("guide.title")}</h2>
        <p className="guide-lead">{t("guide.when")}</p>
        <p className="guide-lead">{t("guide.goal")}</p>

        <div className="guide-during">
          <h3>{t("guide.duringTitle")}</h3>
          <p>{t("guide.during")}</p>
        </div>

        <h3>{t("guide.stepsTitle")}</h3>
        <ol className="guide-steps">
          {GUIDE_STEPS.map((step) => (
            <li key={step.id} className="guide-step">
              <div className="guide-step-head">
                <h4>{t(`guide.steps.${step.id}.title`)}</h4>
                {openButton(step.open)}
              </div>
              <p>{t(`guide.steps.${step.id}.body`)}</p>
              {step.warning && <p className="guide-warning">{t(`guide.steps.${step.id}.warning`)}</p>}
              <p className="guide-done">
                <strong>{t("guide.doneLabel")}</strong> {t(`guide.steps.${step.id}.done`)}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
