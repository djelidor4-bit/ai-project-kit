# 00_Index — ניווט בתיעוד {{PROJECT_NAME}}

> אינדקס בלבד: שורה אחת לכל מסמך. מסמך חדש נוצר → הסוכן הראשי מוסיף לו שורה כאן באותו שינוי.
> הפניות: נתיב יחסי לשורש הריפו בתוך backticks (`docs/decisions-log.md`), לא wiki-links. סוכנים ו-skills — בשמם (`qa`, `gate-check`).

## ⬅ מתחילים כאן
- `AGENTS.md` — החוקה של הפרויקט: מודל העבודה, חוקי הברזל, רמת העצמאות, הצוות, פורמט התשובה.
- `docs/project-status.md` — ⚠️ מקור האמת לשלב העבודה, להקפאות ולמטרת הספרינט הפעיל.

## מסמכי ניהול
- `docs/project-status.md` — שלב, רמת עצמאות (מראה), תחומים מוקפאים, ספרינט פעיל, ממתין, יומן מצב (החדש למעלה).
- `docs/decisions-log.md` — יומן החלטות: קוד, תאריך, רמת נעילה, מי אישר. ללא רמת נעילה — זו לא החלטה, זו שיחה.
- `docs/open-questions.md` — כל מה שלא ידוע, במקום להמציא.
- `docs/tasks.md` — משימות, באגים וחוב טכני. מקור המשימות בפרויקט: {{TASKS_SOURCE}}.
- `docs/daily-summaries.md` — סיכום לכל יום עבודה (החדש למעלה).
- `docs/engineering-operating-model.md` — מודל העבודה ההנדסי: Git מול מקור המשימות, ספרינט שבועי, בעלות, באגים, PR ו-review, לוגים ו-secrets, Definition of Done.
- `docs/environments.md` — מפת הסביבות: כתובת, מה פורס (האם push הוא deploy), שמות משתני סביבה (לא ערכים), יומן שינויי קונפיגורציה.
- `docs/skills-index.md` — אינדקס ה-skills ומיפוי skills ↔ סוכנים.

## מוצר והיקף
- `docs/mvp-scope.md` — גבולות ההיקף; כל פיצ'ר נבחן מולו עם `mvp-fit-check`.

⏳ למלא: מסמך חזון / PRD, אם קיים — **כיוון בלבד** (`readiness-direction`); סתירה מולו — `docs/decisions-log.md` קובע.

## תת-תיקיות — מסמך חדש נולד באחת מהן
- `docs/adr/` — רשומות החלטה ארכיטקטונית (ADR) מעל הסף: גבול בין מאגרים/מערכות · ספק חיצוני · עלות · פרטיות. הכללים: `docs/adr/README.md` · התבנית: `docs/adr/ADR-TEMPLATE.md`.
- `docs/architecture/` — מבנה המערכת (`docs/architecture/README.md`). המסמך הראשון שנכתב שם: `docs/architecture/request-response-flow.md` — זרימת בקשה ותגובה מקצה לקצה; אחריו `docs/architecture/overview.md`.
- `docs/runbooks/` — הוראות הפעלה. `docs/runbooks/local-setup.md` — פקודה אחת להרמה מקומית ופקודה אחת לבדיקה החינמית; `docs/runbooks/release.md` — שחרור וחזרה (נכתב כשיש ייצור).
- `docs/product/` — אפיון מוצר: מסעות, מסכים, נוסחים (`docs/product/microcopy.md` נוצר עם `microcopy-source-of-truth`).
- `docs/data/` — תיעוד נתונים ותוצאות הרצה; מה מותר ומה אסור לשמור בגיט (`docs/data/README.md`).

מסמכי הניהול שלמעלה נשארים בשורש `docs/`. מסמך קיים לא זז; מסמך חדש — Markdown, בתת-התיקייה שלו.

## מסמכים מתוכננים — נכתב כשנדרש

> שם אחד לכל מסמך. סוכן שצריך מסמך שעוד לא נכתב מדווח עליו כפער; הסוכן הראשי כותב אותו **בשם הזה בלבד** ומעדכן כאן.

| מסמך | מה בו | מי קורא |
| :--- | :--- | :--- |
| `docs/architecture/api-contract.md` | חוזה ה-API: נקודות קצה, קלט ופלט, קודי שגיאה, והחוזים מול מערכות חיצוניות | `backend` · `frontend` |
| `docs/data/data-model.md` | מודל הנתונים ומילון הנתונים — **המיקום היחיד**: ישויות, שדות, הבעלים והרגישות של כל שדה | `backend` · `privacy-data-check` |
| `docs/product/test-plan.md` | תוכנית הבדיקות ומטריצת העקיבות (הפלט של `spec-to-test-traceability`, שהסוכן הראשי כותב) | `qa` |

## אם הותקן מודול

| מודול | מסמך | מה בו |
| :--- | :--- | :--- |
| `jira` | `docs/jira-workflow.md` | חיבור, עדכון אוטומטי בסוף כל חלק, באגים, פרטיות בפרויקט משותף, נפילה ל-`docs/tasks.md` |
| `web` | `docs/design-system.md` | שפת העיצוב הנעולה (טוקנים) — שינוי = החלטה ביומן |
| `web` | `docs/frontend-api-guidelines.md` | הנחיות הנדסיות ל-frontend ולצריכת API |
| `ai-product` | `docs/prompts-and-json-governance.md` | prompts ו-JSON כנכסים הנדסיים: גרסאות, PR, בדיקות שחרור, בדיקות בתשלום רק בתקציב |

## קבצי הערכה מחוץ ל-`docs/`

| נתיב | מה זה | עורכים? |
| :--- | :--- | :--- |
| `AGENTS.md` | החוקה — Codex קורא אותו ישירות | רק באישור מפורש של בעל הפרויקט, בכל רמה; אחריו `node .kit/check.mjs`. חריג: שורת רמת העצמאות משתנה לפי מילותיו של בעל הפרויקט (`AGENTS.md` §3) |
| `CLAUDE.md` | שורה ראשונה `@AGENTS.md` + הערות ל-Claude Code | רק באישור מפורש של בעל הפרויקט, בכל רמה, בלי למחוק את שורת הייבוא; אחריו `node .kit/check.mjs` |
| `.claude/agents/` | הגדרות הסוכנים — המקור הקנוני | רק באישור מפורש של בעל הפרויקט, בכל רמה; אחריו `node .kit/check.mjs --fix` |
| `.claude/skills/` | ה-skills — המקור הקנוני | רק באישור מפורש של בעל הפרויקט, בכל רמה; אחריו `node .kit/check.mjs --fix` |
| `.codex/agents/*.toml` | סוכני Codex — נוצרים מהמקור הקנוני | ⛔ לא עורכים ידנית |
| `.agents/skills/` | מראה של ה-skills ל-Codex | ⛔ לא עורכים ידנית |
| `.kit/kit.config.json` | גרסת הערכה, תאריך התקנה, כלים ומודולים | רק המתקין |
| `.kit/check.mjs` | בדיקת תקינות: `node .kit/check.mjs` | ⛔ לא עורכים |
| `.kit/values.json` | השמות והטקסטים שמילאו את ה-placeholders בהתקנה — **בלי secrets**; ההתקנה בעדכון (`--update`) משתמשת בו שוב | הסוכן הראשי מרענן אותו לפי המצב של היום (רמת עצמאות, שלב, צוות, מקור המשימות) לפני כל `--update` |
| `.kit/backup/` | גיבוי קבצים שנדרסו או נמחקו בהתקנה או ב-`--fix` (תיקייה לכל חותמת זמן) | ⛔ לא עורכים; מומלץ להוסיף ל-`.gitignore` |

בהתקנה ל-Codex בלבד: המקור הקנוני של הסוכנים הוא `.kit/agents-src/*.md`, ושל ה-skills — `.agents/skills/` (אותו כלל אישור, ואחריו `node .kit/check.mjs --fix`).
