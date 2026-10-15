# 给 OpenMausBot 的 issue 草稿

发到 https://github.com/milind-soni/OpenMausBot/issues/new ，用你自己的 GitHub 账号。下面英文部分原样贴进去即可。

我要确认三件事。生成好的身体轮廓和表情几何是否在 Apache-2.0 里。Blob Studio 有没有单独的许可或署名要求。仓库 LICENSING.md 说吉祥物是 Supamaus Software Private Limited 的商标，我们只把它当 bot 头像用、不当产品标志，这样行不行。

---

**Title:** Reusing the CursorAvatar runtime and generated mascot bodies as bot avatars in an Apache-2.0 project

Hi! I maintain [omp-bot](https://github.com/jryang1997/omp-bot), a small Apache-2.0 local multi-agent app. We would like to use your mascot renderer for our bots' avatars, and want to do it the way you are comfortable with.

**What we plan to take** (from commit `330b098`)

- The renderer part of `src/components/CursorAvatar.tsx` (everything above the React component), rewritten as a framework-free custom element.
- `src/components/cursor-face-data.ts`, unchanged.
- The generated outlines in `shared/mascot-bodies.ts`, unchanged except for dropping the zod schema.
- The colour palette from `src/lib/mascot.ts`.

**What we will not take**

- `scripts/mascot-shapes/*` and the body generator. Your docs say `sdf.ts` and `solve.ts` are copied verbatim from Blob Studio, so we leave them out.
- The OpenMausBot and MausBot names, anywhere in our product.

**How we credit it**

- Your LICENSE and the relevant NOTICE lines ship with our copy, plus a NOTICE entry naming OpenMausBot and the commit.
- The file header keeps "Made with Blob Studio."
- The mascot is used only as each bot's avatar inside the app. It is not our app icon, logo or product name.

**Questions**

1. Are the generated body outlines and the face geometry covered by the repository's Apache-2.0 licence, like the rest of the code outside `enterprise/`?
2. Is Blob Studio a separate work with its own licence or attribution wording we should include?
3. `LICENSING.md` says the mascot is a trademark of Supamaus Software Private Limited. Is the use above (bot avatars inside another app, credited, not used as our brand) acceptable? If not, we will keep the renderer and replace the bodies and face with our own drawings. Is keeping the renderer with different artwork fine?

Thanks for building this, the expression engine is lovely.
