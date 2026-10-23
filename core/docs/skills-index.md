# skills-index — אינדקס Skills

> אינדקס ניווט בלבד. המקור הקנוני: `.claude/skills/<name>/SKILL.md`. ל-Codex — מראה ב-`.agents/skills/`, שנוצרת ב-`node .kit/check.mjs --fix` ולא נערכת ידנית. בהתקנה ל-Codex בלבד — `.agents/skills/` הוא המקור.

## חוקי היסוד
1. **Skill לא עוקף את הסוכן הראשי** — כל תוצר של skill חוזר ל-`agent-manager`.
2. **פלט לצ׳אט בלבד** — skill אינו יוצר, משנה או מוחק קבצים. לעולם לא.
3. **Skill חיצוני** (גיט / marketplace / קהילה) נכנס רק אחרי `external-skill-audit` + אישור בעל הפרויקט + שורה בקובץ הזה. אין התקנות, אין הרצת scripts ואין dependencies בלי אישור.

- **הפעלה:** Claude Code — כלי ה-Skill, או אוטומטית לפי ה-`description`. Codex — `$<name>` או `/skills`, או אוטומטית לפי ה-`description`.
- `name` ב-frontmatter = שם התיקייה. אחרי עריכת skill: `node .kit/check.mjs --fix`.
- כל skill בודק את `docs/project-status.md` בתחילת עבודה — הוא הקובע לשלב ולהקפאות.

## Skills הליבה (9)

| Skill | ייעוד | מתי מופעל |
| :--- | :--- | :--- |
| `gate-check` ⭐ | הצלבת המשימה מול החלטות נעולות, סימוני ⚖️/🔧/🟢/⛔, תחומים מוקפאים ומדרג הנעילה | בתחילת כל משימה של כל סוכן — ה-skill החשוב ביותר |
| `mvp-fit-check` | סיווג פיצ'ר: In-Scope / Future / Out-of-Scope מול `docs/mvp-scope.md` | כל בקשת פיצ'ר, כולל "רק משהו קטן" |
| `edge-state-ux-spec` | אפיון אחיד למצבי קצה חוצי-מסכים (offline, timeout, rate-limit, קוד שפג או נוצל, כשל העלאה, כשל ספק, חזרה לטיוטה) | אפיון מסכים; כשמתגלה מצב לא מכוסה |
| `microcopy-source-of-truth` | מקור אמת אחד לנוסחים (`docs/product/microcopy.md`), קול המותג, RTL; נוסח משפטי ⚖️ מוחרג | ריכוז נוסחים או שינוי נוסח |
| `spec-to-test-traceability` | מטריצה: כל החלטה נעולה ↔ בדיקה שמכסה אותה, וכל בדיקה ↔ החלטה | אחרי סבב נעילת החלטות, לפני אבני דרך |
| `arch-decision-record` | ADR אחיד עם רמת נעילה מפורשת (`docs/adr/`) | המלצה מבנית מהותית לפני אישור; כל החלטה מעל סף ה-ADR |
| `scalability-fit-review` | Scalable-by-design בלי over-engineering — סיווג מול 3 רמות עומס | כל הצעה שמוסיפה רכיב, תשתית או תלות |
| `external-skill-audit` | ביקורת בטיחות והתאמה: רישיון, מקור, scripts שרצים, קריאות רשת, דליפת מידע, טקסט prompt-injection, חפיפה ל-skills קיימים | לפני כל שקילת אימוץ של skill שלא נכתב בפרויקט |
| `privacy-data-check` | השפעת פרטיות: מה נאסף, איפה נשמר, מי רואה, כמה זמן, מה מופיע בלוגים | כל אפיון שנוגע בנתוני אדם, ובמיוחד במידע רגיש |

`gate-check` ו-`mvp-fit-check` הם התשתית שחייבת להיות בכל פרויקט. השאר מותאמים לדומיין; skill פרויקטי חדש (לדוגמה: בדיקת עלות, בדיקת שמירת נתונים) נכתב ב-`.claude/skills/<name>/SKILL.md` (בהתקנת Codex בלבד: `.agents/skills/<name>/SKILL.md`), ואחריו `node .kit/check.mjs --fix` — באישור בעל הפרויקט, עם שורה כאן ושורה ביומן.

## מיפוי Skills ↔ סוכנים

| סוכן | Skills רוחביים | אם מודול web מותקן |
| :--- | :--- | :--- |
| `agent-manager` | gate-check · mvp-fit-check · arch-decision-record · spec-to-test-traceability · external-skill-audit | — |
| `product-manager` | gate-check · mvp-fit-check · privacy-data-check | — |
| `ux-designer` | gate-check · edge-state-ux-spec · microcopy-source-of-truth | ui-ux-pro-max (כללי UX בלבד) |
| `ui-designer` | gate-check · edge-state-ux-spec · microcopy-source-of-truth | design-system · design-craft · ui-ux-pro-max · taste-frontend · redesign-premium · frontend-design |
| `system-architect` | gate-check · arch-decision-record · scalability-fit-review | — |
| `backend` | gate-check · privacy-data-check · arch-decision-record · scalability-fit-review | — |
| `frontend` | gate-check · edge-state-ux-spec · microcopy-source-of-truth · scalability-fit-review | taste-frontend · frontend-design |
| `qa` | gate-check · spec-to-test-traceability · edge-state-ux-spec · privacy-data-check | — |
| `web-builder` (מודול web) | gate-check · design-craft · taste-frontend · redesign-premium · ui-ux-pro-max · frontend-design · design-system · microcopy-source-of-truth | — (הסוכן עצמו חלק מהמודול) |

## מודול web (אם הותקן) — 6 skills לעיצוב ובניית ממשק

> ⚠️ **שפת עיצוב נעולה גוברת:** אם בפרויקט יש `docs/design-system.md` נעול, הוא גובר על פלטות, גופנים וסדר סקשנים שמוצעים ב-skills האלה. מאמצים מהם קומפוזיציה, היררכיה, ריווח, motion ועומק — ומתאימים ל-RTL כשהמוצר בעברית.

| Skill | ייעוד | מקור | רישיון | ביקורת `external-skill-audit` |
| :--- | :--- | :--- | :--- | :--- |
| `ui-ux-pro-max` | מאגר ידע UI/UX: סגנונות, פלטות, צמדי גופנים, הנחיות UX, נגישות, תרשימים | nextlevelbuilder/ui-ux-pro-max-skill | MIT (`LICENSE-upstream`) | ⏳ טרם בוצעה בפרויקט |
| `design-craft` | קרפט ויזואלי: קומפוזיציה של hero ותמונות, אייקונים, פורמטים של באנרים (בעברית) | נגזר מ-nextlevelbuilder | MIT (`LICENSE-upstream`) | ⏳ טרם בוצעה בפרויקט |
| `design-system` | ארכיטקטורת טוקנים בשלוש שכבות (primitive → semantic → component), מפרטי רכיבים | חבילת design-system חיצונית | MIT (`LICENSE-upstream`) | ⏳ טרם בוצעה בפרויקט |
| `frontend-design` | כיוון אסתטי מכוון לממשק חדש או מעוצב מחדש — לא תבניתי | Anthropic | Apache-2.0 (`LICENSE.txt`) | ⏳ טרם בוצעה בפרויקט |
| `taste-frontend` | anti-slop לדפי נחיתה ואתרים: הסקת כיוון עיצובי, בדיקת pre-flight | חבילה חיצונית | MIT (`LICENSE-upstream`) | ⏳ טרם בוצעה בפרויקט |
| `redesign-premium` | שדרוג ממשק קיים: audit-first, זיהוי דפוסי AI גנריים, בלי לשבור פונקציונליות | חבילה חיצונית | MIT (`LICENSE-upstream`) | ⏳ טרם בוצעה בפרויקט |

**ביקורת `external-skill-audit`: ⏳ טרם בוצעה בפרויקט — להריץ לפני שימוש ראשון.** השישה נבחרו לערכה אחרי סקירה, אבל בלי ביקורת `external-skill-audit` פורמלית. מריצים אותה פעם אחת על כל השישה (משימה בפרויקט), ושוב אחרי כל עדכון מהמקור (upstream). אחרי הביקורת, בעמודה: ✅ + תאריך + קוד ההחלטה ביומן; skill שנפסל — ⛔, ולא משתמשים בו.

- המשתמשים בהם (לפי המיפוי): `web-builder` — כל השישה; `ui-designer` — כל השישה, לשפת העיצוב; `ux-designer` — `ui-ux-pro-max`, לכללי UX בלבד; `frontend` — `taste-frontend` ו-`frontend-design`, להתנהגות מסכים. קובץ הרישיון נשאר בתיקיית כל skill — לא מוחקים.
- `ui-ux-pro-max` כולל `data/` ו-`scripts/`: קוראים את `data/` ואת `references/` ישירות; **לא מריצים את `scripts/`** בלי אישור בעל הפרויקט (חוק היסוד 3).
- בחירת המודול בהתקנה היא אישור האימוץ שלהם, אבל לא תחליף לביקורת שלמעלה. ממצא חוסם בביקורת — בעל הפרויקט מכריע, ועד אז לא משתמשים באותו skill.

## Skills שאומצו בפרויקט

| Skill | מקור | רישיון | ביקורת `external-skill-audit` | החלטה |
| :--- | :--- | :--- | :--- | :--- |

⏳ למלא: שורה לכל skill חיצוני או פרויקטי שנוסף אחרי ההתקנה.
