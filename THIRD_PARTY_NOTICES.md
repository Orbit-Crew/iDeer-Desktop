# Third-party notices（随包第三方资源通知与清单）

This package derives from LINZ by LINZ Team, repository
https://github.com/Neowyh/linz, commit
f88141bb3d3450a572fcc52e0f9b48a1e60d3b13. As of issue #88 every third-party
item that ships — or is deliberately not shipped — is recorded per item in the
machine-readable inventory resources/provenance/third-party-inventory.json
(shipped with the package) and mirrored in the ledger table below. Each entry
records 来源 (upstream source and pin), 许可证 (declared license plus evidence),
上游维护者 (upstream maintainer) and 负责维护者 (downstream responsible
maintainer). `npm run verify:third-party` (scripts/verify-third-party.cjs)
fails on any drift between the inventory, the pin files
(resources/provenance/linz-source.json, local-runtime/distribution.lock.json,
package-lock.json, electron-builder.yml) and this file.

## Release precondition（发布前置检查）

- `npm run verify:third-party` must exit 0 before any release build is
  published. It fails (typed error codes) when a shipped third-party artifact
  is absent from the inventory (SHIPPED_NOT_INVENTORIED), an inventory entry
  claims shipment that does not ship (INVENTORY_NOT_SHIPPED), a mirrored pin
  drifts (PIN_DRIFT), a dev dependency is claimed as distributed
  (DEPENDENCY_CLASS_MISMATCH), this ledger drifts from the inventory
  (NOTICES_DRIFT), or the pending human-gate set changes
  (PENDING_GATE_MISMATCH). Missing core input files (locks, pin files,
  builder config) abort the run with the raw read error, like the sibling
  verify-provenance script. CI runs it in both PR jobs next to
  `npm run verify:provenance`.
- Exactly one human gate is tracked today: **linz-license-grant**. The
  maintainer (the upstream repository owner) must resolve it before any public
  distribution (see below). Resolving it — or adding a new genuine gate —
  requires one reviewed change that updates both the inventory `humanGates`
  and `TRACKED_HUMAN_GATES` in scripts/verify-third-party.cjs; anything else
  fails verification.
- The LGPL-2.1 obligations for `occt-import-js` (shipping the license text
  with the package and providing a corresponding-source offer for the LGPL
  components) are recorded here as maintainer release-time duties;
  `verify:third-party` does not machine-check that they have been met.

## Unresolved release blocker: the linz upstream grant

That commit declares `MIT` in package.json. The exact original package.json and
package-lock.json are preserved in resources/provenance. The source tree has no
root LICENSE file. No copyright year or missing license text has been invented.
The maintainer must obtain and verify the upstream license grant and notices
before distribution. This is an unresolved release blocker.
The Desktop package is marked UNLICENSED while this verification is pending;
this does not replace or remove the upstream MIT declaration.

Copied and adapted source files, source hashes, compatibility changes and deferred
assets are listed in docs/porting.md and resources/provenance/linz-source.json.
No third-party skills, fonts or icons from linz are distributed in this baseline;
their deliberate exclusion is recorded per item in the ledger below.
Ant Design icons are installed from the locked npm package.

## Item ledger（逐项清单）

The rows below must reference exactly the item ids of
resources/provenance/third-party-inventory.json in both directions, each id
exactly once. The id, 许可证, 上游维护者, 负责维护者, 随包 and 状态 cells are
machine-compared against the inventory fields (the 状态 cell must begin with
the inventory status value); the 组件 and 来源 cells and all prose remain
free-form. 许可证 cites the evidence recorded in the inventory entry.

| 清单 id | 组件/版本 | 来源 | 许可证 | 上游维护者 | 负责维护者 | 随包 | 状态/说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `linz-derivation` | linz | https://github.com/Neowyh/linz @ f88141b | MIT（仅上游 package.json 声明；上游仓库无 LICENSE 文本） | LINZ Team（Neowyh，上游仓库所有者） | Neowyh（组织维护者：来源与许可证核验、发布签核） | 是 | pending-maintainer-verification（人工门 linz-license-grant） |
| `electron@22.3.27` | Electron 22.3.27 | https://github.com/electron/electron | MIT（Chromium/Node.js 等内嵌组件以随包 LICENSES.chromium.html 为准） | OpenJS Foundation 与 Electron 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `occt-import-js` | occt-import-js 0.0.23 | https://github.com/kovacsv/occt-import-js | LGPL-2.1（glue 与 WASM 均属上游项目；内嵌 OCCT 同为 LGPL-2.1，附 OCCT 开发例外条款） | kovacsv（Viktor Kovács）；内嵌 OCCT：Open CASCADE SAS 与 OCCT 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `ideer-runtime-core` | iDeer Runtime core（local-runtime/core） | https://github.com/Orbit-Crew/iDeer @ ccb251e | MIT（LICENSE.upstream，含 Bytedance Ltd. 与 iDeer Authors 版权行） | Orbit-Crew（iDeer 仓库侧） | Orbit-Crew | 是 | verified（证据已记录） |
| `runtime-archive:python-3.12.10-embed-amd64.zip` | CPython 3.12.10（Windows embeddable, win_amd64） | https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip | PSF-2.0 | Python Software Foundation | Orbit-Crew | 是 | verified（证据已记录） |
| `runtime-archive:cryptography-43.0.3-cp39-abi3-win_amd64.whl` | cryptography 43.0.3 wheel | https://files.pythonhosted.org/packages/87/5c/3dab83cc4aba1f4b0e733e3f0c3e7d4386440d660ba5b1e3ff995feb734d/cryptography-43.0.3-cp39-abi3-win_amd64.whl | Apache-2.0 OR BSD-3-Clause | Python Cryptographic Authority（PyCA） | Orbit-Crew | 是 | verified（证据已记录） |
| `runtime-archive:cffi-1.17.1-cp312-cp312-win_amd64.whl` | cffi 1.17.1 wheel | https://files.pythonhosted.org/packages/50/b9/db34c4755a7bd1cb2d1603ac3863f22bcecbd1ba29e5ee841a4bc510b294/cffi-1.17.1-cp312-cp312-win_amd64.whl | MIT | PyPy 团队（Armin Rigo、Maciej Fijalkowski 等） | Orbit-Crew | 是 | verified（证据已记录） |
| `runtime-archive:pycparser-2.22-py3-none-any.whl` | pycparser 2.22 wheel | https://files.pythonhosted.org/packages/13/a3/a812df4e2dd5696d1f351d58b8fe16a405b234ad2886a0dab9183fb78109/pycparser-2.22-py3-none-any.whl | BSD-3-Clause | Eli Bendersky | Orbit-Crew | 是 | verified（证据已记录） |
| `runtime-archive:pypdf-5.1.0-py3-none-any.whl` | pypdf 5.1.0 wheel | https://files.pythonhosted.org/packages/04/fc/6f52588ac1cb4400a7804ef88d0d4e00cfe57a7ac6793ec3b00de5a8758b/pypdf-5.1.0-py3-none-any.whl | BSD-3-Clause | Martin Thoma（维护者） | Orbit-Crew | 是 | verified（证据已记录） |
| `runtime-archive:websockets-13.1-cp312-cp312-win_amd64.whl` | websockets 13.1 wheel | https://files.pythonhosted.org/packages/46/93/e19160db48b5581feac8468330aa11b7292880a94a37d7030478596cc14e/websockets-13.1-cp312-cp312-win_amd64.whl | BSD-3-Clause | Aymeric Augustin | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/colors@7.2.1` | @ant-design/colors | https://registry.npmjs.org/@ant-design/colors/-/colors-7.2.1.tgz | MIT | afc163 <afc163@gmail.com> | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/cssinjs@1.24.0` | @ant-design/cssinjs | https://registry.npmjs.org/@ant-design/cssinjs/-/cssinjs-1.24.0.tgz | MIT | Ant Group（Ant Design 团队）与社区贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/cssinjs-utils@1.1.3` | @ant-design/cssinjs-utils | https://registry.npmjs.org/@ant-design/cssinjs-utils/-/cssinjs-utils-1.1.3.tgz | MIT | Ant Group（Ant Design 团队）与社区贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/fast-color@2.0.6` | @ant-design/fast-color | https://registry.npmjs.org/@ant-design/fast-color/-/fast-color-2.0.6.tgz | MIT | Guo Yunhe (https://guoyunhe.me/) | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/icons@5.6.1` | @ant-design/icons | https://registry.npmjs.org/@ant-design/icons/-/icons-5.6.1.tgz | MIT | Ant Group（Ant Design 团队）与社区贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/icons-svg@4.6.0` | @ant-design/icons-svg | https://registry.npmjs.org/@ant-design/icons-svg/-/icons-svg-4.6.0.tgz | MIT | Ant Group（Ant Design 团队）与社区贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@ant-design/react-slick@1.1.2` | @ant-design/react-slick | https://registry.npmjs.org/@ant-design/react-slick/-/react-slick-1.1.2.tgz | MIT | Kiran Abburi | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@babel/runtime@7.29.10` | @babel/runtime | https://registry.npmjs.org/@babel/runtime/-/runtime-7.29.10.tgz | MIT | The Babel Team (https://babel.dev/team) | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@emotion/hash@0.8.0` | @emotion/hash | https://registry.npmjs.org/@emotion/hash/-/hash-0.8.0.tgz | MIT | Emotion 团队与贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@emotion/unitless@0.7.5` | @emotion/unitless | https://registry.npmjs.org/@emotion/unitless/-/unitless-0.7.5.tgz | MIT | Emotion 团队与贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/async-validator@5.1.2` | @rc-component/async-validator | https://registry.npmjs.org/@rc-component/async-validator/-/async-validator-5.1.2.tgz | MIT | Ant Design 团队与社区贡献者（rc-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/color-picker@2.0.1` | @rc-component/color-picker | https://registry.npmjs.org/@rc-component/color-picker/-/color-picker-2.0.1.tgz | MIT | Ant Design 团队与社区贡献者（rc-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/context@1.4.0` | @rc-component/context | https://registry.npmjs.org/@rc-component/context/-/context-1.4.0.tgz | MIT | Ant Design 团队与社区贡献者（rc-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/mini-decimal@1.1.4` | @rc-component/mini-decimal | https://registry.npmjs.org/@rc-component/mini-decimal/-/mini-decimal-1.1.4.tgz | MIT | smith3816@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/mutate-observer@1.1.0` | @rc-component/mutate-observer | https://registry.npmjs.org/@rc-component/mutate-observer/-/mutate-observer-1.1.0.tgz | MIT | 574980606@qq.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/portal@1.1.2` | @rc-component/portal | https://registry.npmjs.org/@rc-component/portal/-/portal-1.1.2.tgz | MIT | smith3816@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/qrcode@1.1.3` | @rc-component/qrcode | https://registry.npmjs.org/@rc-component/qrcode/-/qrcode-1.1.3.tgz | MIT | Ant Design 团队与社区贡献者（rc-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/tour@1.15.1` | @rc-component/tour | https://registry.npmjs.org/@rc-component/tour/-/tour-1.15.1.tgz | MIT | wangning4567@163.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@rc-component/trigger@2.3.1` | @rc-component/trigger | https://registry.npmjs.org/@rc-component/trigger/-/trigger-2.3.1.tgz | MIT | Ant Design 团队与社区贡献者（rc-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@xterm/addon-fit@0.10.0` | @xterm/addon-fit | https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.10.0.tgz | MIT | The xterm.js authors (https://xtermjs.org/) | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:@xterm/xterm@5.5.0` | @xterm/xterm | https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz | MIT | xterm.js 贡献者（https://xtermjs.org/） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:antd@5.29.3` | antd | https://registry.npmjs.org/antd/-/antd-5.29.3.tgz | MIT | Ant Group（Ant Design 团队）与社区贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:classnames@2.5.1` | classnames | https://registry.npmjs.org/classnames/-/classnames-2.5.1.tgz | MIT | Jed Watson | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:compute-scroll-into-view@3.1.1` | compute-scroll-into-view | https://registry.npmjs.org/compute-scroll-into-view/-/compute-scroll-into-view-3.1.1.tgz | MIT | Cody Olsen | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:copy-to-clipboard@3.3.3` | copy-to-clipboard | https://registry.npmjs.org/copy-to-clipboard/-/copy-to-clipboard-3.3.3.tgz | MIT | sudodoki <smd.deluzion@gmail.com> | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:csstype@3.2.3` | csstype | https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz | MIT | Fredrik Nicol <fredrik.nicol@gmail.com> | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:dayjs@1.11.23` | dayjs | https://registry.npmjs.org/dayjs/-/dayjs-1.11.23.tgz | MIT | iamkun | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:js-tokens@4.0.0` | js-tokens | https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz | MIT | Simon Lydell | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:json2mq@0.2.0` | json2mq | https://registry.npmjs.org/json2mq/-/json2mq-0.2.0.tgz | MIT | Kiran Abburi | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:loose-envify@1.4.0` | loose-envify | https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz | MIT | Andres Suarez <zertosh@gmail.com> | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:node-pty@1.1.0` | node-pty | https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz | MIT | Microsoft Corporation | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:node-addon-api@7.1.1` | node-addon-api | https://registry.npmjs.org/node-addon-api/-/node-addon-api-7.1.1.tgz | MIT | Microsoft Corporation 与贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-cascader@3.34.0` | rc-cascader | https://registry.npmjs.org/rc-cascader/-/rc-cascader-3.34.0.tgz | MIT | afc163@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-checkbox@3.5.0` | rc-checkbox | https://registry.npmjs.org/rc-checkbox/-/rc-checkbox-3.5.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-collapse@3.9.0` | rc-collapse | https://registry.npmjs.org/rc-collapse/-/rc-collapse-3.9.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-dialog@9.6.0` | rc-dialog | https://registry.npmjs.org/rc-dialog/-/rc-dialog-9.6.0.tgz | MIT | yiminghe@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-drawer@7.3.0` | rc-drawer | https://registry.npmjs.org/rc-drawer/-/rc-drawer-7.3.0.tgz | MIT | 155259966@qq.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-dropdown@4.2.1` | rc-dropdown | https://registry.npmjs.org/rc-dropdown/-/rc-dropdown-4.2.1.tgz | MIT | yiminghe@gmail.com, hualei5280@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-field-form@2.7.1` | rc-field-form | https://registry.npmjs.org/rc-field-form/-/rc-field-form-2.7.1.tgz | MIT | smith3816@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-image@7.12.0` | rc-image | https://registry.npmjs.org/rc-image/-/rc-image-7.12.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-input@1.8.0` | rc-input | https://registry.npmjs.org/rc-input/-/rc-input-1.8.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-input-number@9.5.0` | rc-input-number | https://registry.npmjs.org/rc-input-number/-/rc-input-number-9.5.0.tgz | MIT | tsjxyz@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-mentions@2.20.0` | rc-mentions | https://registry.npmjs.org/rc-mentions/-/rc-mentions-2.20.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-menu@9.16.1` | rc-menu | https://registry.npmjs.org/rc-menu/-/rc-menu-9.16.1.tgz | MIT | yiminghe@gmail.com, hualei5280@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-motion@2.9.5` | rc-motion | https://registry.npmjs.org/rc-motion/-/rc-motion-2.9.5.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-notification@5.6.4` | rc-notification | https://registry.npmjs.org/rc-notification/-/rc-notification-5.6.4.tgz | MIT | yiminghe@gmail.com, skyking_H@hotmail.com, hust2012jiangkai@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-overflow@1.5.0` | rc-overflow | https://registry.npmjs.org/rc-overflow/-/rc-overflow-1.5.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-pagination@5.1.0` | rc-pagination | https://registry.npmjs.org/rc-pagination/-/rc-pagination-5.1.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-picker@4.11.3` | rc-picker | https://registry.npmjs.org/rc-picker/-/rc-picker-4.11.3.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-progress@4.0.0` | rc-progress | https://registry.npmjs.org/rc-progress/-/rc-progress-4.0.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-rate@2.13.1` | rc-rate | https://registry.npmjs.org/rc-rate/-/rc-rate-2.13.1.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-resize-observer@1.4.3` | rc-resize-observer | https://registry.npmjs.org/rc-resize-observer/-/rc-resize-observer-1.4.3.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-segmented@2.7.1` | rc-segmented | https://registry.npmjs.org/rc-segmented/-/rc-segmented-2.7.1.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-select@14.16.8` | rc-select | https://registry.npmjs.org/rc-select/-/rc-select-14.16.8.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-slider@11.1.9` | rc-slider | https://registry.npmjs.org/rc-slider/-/rc-slider-11.1.9.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-steps@6.0.1` | rc-steps | https://registry.npmjs.org/rc-steps/-/rc-steps-6.0.1.tgz | MIT | afc163 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-switch@4.1.0` | rc-switch | https://registry.npmjs.org/rc-switch/-/rc-switch-4.1.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-table@7.54.0` | rc-table | https://registry.npmjs.org/rc-table/-/rc-table-7.54.0.tgz | MIT | yiminghe@gmail.com, afc163@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-tabs@15.7.0` | rc-tabs | https://registry.npmjs.org/rc-tabs/-/rc-tabs-15.7.0.tgz | MIT | yiminghe@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-textarea@1.10.2` | rc-textarea | https://registry.npmjs.org/rc-textarea/-/rc-textarea-1.10.2.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-tooltip@6.4.0` | rc-tooltip | https://registry.npmjs.org/rc-tooltip/-/rc-tooltip-6.4.0.tgz | MIT | yiminghe@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-tree@5.13.1` | rc-tree | https://registry.npmjs.org/rc-tree/-/rc-tree-5.13.1.tgz | MIT | smith3816@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-tree-select@5.27.0` | rc-tree-select | https://registry.npmjs.org/rc-tree-select/-/rc-tree-select-5.27.0.tgz | MIT | smith3816@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-upload@4.11.0` | rc-upload | https://registry.npmjs.org/rc-upload/-/rc-upload-4.11.0.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-util@5.44.4` | rc-util | https://registry.npmjs.org/rc-util/-/rc-util-5.44.4.tgz | MIT | Ant Design 团队与社区贡献者（react-component 组织） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:rc-virtual-list@3.19.2` | rc-virtual-list | https://registry.npmjs.org/rc-virtual-list/-/rc-virtual-list-3.19.2.tgz | MIT | smith3816@gmail.com | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:react@18.3.1` | react | https://registry.npmjs.org/react/-/react-18.3.1.tgz | MIT | Meta Platforms 与 React 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:react-dom@18.3.1` | react-dom | https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz | MIT | Meta Platforms 与 React 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:react-is@18.3.1` | react-is | https://registry.npmjs.org/react-is/-/react-is-18.3.1.tgz | MIT | Meta Platforms 与 React 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:resize-observer-polyfill@1.5.1` | resize-observer-polyfill | https://registry.npmjs.org/resize-observer-polyfill/-/resize-observer-polyfill-1.5.1.tgz | MIT | Denis Rul <que.etc@gmail.com> | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:scheduler@0.23.2` | scheduler | https://registry.npmjs.org/scheduler/-/scheduler-0.23.2.tgz | MIT | Meta Platforms 与 React 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:scroll-into-view-if-needed@3.1.0` | scroll-into-view-if-needed | https://registry.npmjs.org/scroll-into-view-if-needed/-/scroll-into-view-if-needed-3.1.0.tgz | MIT | Cody Olsen | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:string-convert@0.2.1` | string-convert | https://registry.npmjs.org/string-convert/-/string-convert-0.2.1.tgz | MIT | 未声明（发布者见 npm registry 记录，tarball 由下方 source 固定） | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:stylis@4.4.0` | stylis | https://registry.npmjs.org/stylis/-/stylis-4.4.0.tgz | MIT | Sultan Tarimo <sultantarimo@me.com> | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:three@0.185.1` | three | https://registry.npmjs.org/three/-/three-0.185.1.tgz | MIT | mrdoob | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:throttle-debounce@5.0.2` | throttle-debounce | https://registry.npmjs.org/throttle-debounce/-/throttle-debounce-5.0.2.tgz | MIT | Ivan Nikolić <niksy5@gmail.com> (http://ivannikolic.com) | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:toggle-selection@1.0.6` | toggle-selection | https://registry.npmjs.org/toggle-selection/-/toggle-selection-1.0.6.tgz | MIT | sudodoki <smd.deluzion@gmail.com> (sudodoki.name) | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:use-sync-external-store@1.7.0` | use-sync-external-store | https://registry.npmjs.org/use-sync-external-store/-/use-sync-external-store-1.7.0.tgz | MIT | Meta Platforms 与 React 贡献者 | Orbit-Crew | 是 | verified（证据已记录） |
| `npm:zustand@4.5.7` | zustand | https://registry.npmjs.org/zustand/-/zustand-4.5.7.tgz | MIT | Paul Henschel | Orbit-Crew | 是 | verified（证据已记录） |
| `not-shipped:linz-skills` | linz 第三方技能集 | https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13 | 未核验（不随包） | LINZ Team（Neowyh） | Neowyh | 否 | not-shipped（不随包）。需另行安装/替换：本包不含 linz 的第三方技能；如需使用须自行获取并核验相应授权。 |
| `not-shipped:linz-fonts-icons` | linz 字体与图标资源 | https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13 | 未核验（不随包） | LINZ Team（Neowyh） | Neowyh | 否 | not-shipped（不随包）。需另行安装/替换：本包不含 linz 字体/图标；当前界面图标来自随包的 @ant-design/icons npm 包。 |
| `not-shipped:npm-dev-dependencies` | package.json devDependencies（@types/three 0.185.4、@types/react 等类型包，electron-builder、vite、vitest 等构建工具） | https://registry.npmjs.org/ | 各异（示例：@types/three 0.185.4 为 Apache-2.0；electron 构建工具为 MIT） | 各上游维护者（见 package-lock.json dev 条目） | Orbit-Crew | 否 | not-shipped（不随包）。不随包：@types/* 等开发依赖仅在开发环境经 npm ci 安装，最终用户无需获取。 |

## Significant items（要点）

- **`linz-derivation`** — the whole desktop codebase is a managed derivation
  of the linz commit above (main process, renderer, dock framework, build
  configuration and the resources/compat/node16-banner.cjs compatibility
  banner), trimmed and adapted rather than line-for-line. The upstream grant is
  the tracked human gate above; the release blocker language stays in force.
- **`occt-import-js`** — the CAD viewer's OpenCASCADE converter (glue
  `occt-import-js.js` and `occt-import-js.wasm` under `occt/`), copied
  byte-for-byte from the linz commit above, with SHA-256 hashes pinned in
  resources/provenance/linz-source.json. **License correction (issue #88):**
  an earlier revision of this file recorded occt-import-js as MIT. Per-item
  verification against the archived upstream lock
  (resources/provenance/linz-package-lock.json: occt-import-js 0.0.23,
  license LGPL-2.1) and the upstream repository LICENSE.md shows the project
  declares **LGPL-2.1**, not MIT; the WASM embeds Open CASCADE Technology
  (OCCT), distributed under the LGPL-2.1 with the OCCT development exception
  (upstream: Kovacsv / kovacsv for occt-import-js; Open CASCADE SAS and OCCT
  contributors for the embedded library). The maintainer must still verify the
  upstream grants and notices against the exact artifact and complete the LGPL
  obligations (license text and corresponding-source offer) before
  distribution — the release blocker above applies to these binaries in
  particular, because they are the first third-party binaries shipped from the
  linz side of the derivation.
- **`npm:three@0.185.1`** — exact npm pin, renderer-side WebGL rendering for
  the CAD pane, licensed MIT upstream (https://threejs.org).
  `@types/three` 0.185.4 is a devDependency under Apache-2.0 and is not
  distributed (see `not-shipped:npm-dev-dependencies`).
- **`electron@22.3.27`** and the npm entries — Electron and installed npm
  dependencies retain their own licenses in the installed packages and the
  Electron distribution. The effective dependency set is package-lock.json,
  distinct from the archived upstream lock. Build artifacts must retain
  Electron's LICENSE and LICENSES.chromium.html and dependency notices.
- **`ideer-runtime-core` and the `runtime-archive:` entries** — the Python
  Local Runtime is copied from Orbit-Crew/iDeer commit
  ccb251e07e5f5934b851e4c3df00224718f28123. Its MIT notice (including the
  Bytedance Ltd. and iDeer Authors copyright lines) is retained in
  local-runtime/LICENSE.upstream and shipped as runtime/LICENSE.ideer-runtime.txt.
  The migration manifest and changes are recorded in docs/runtime-migration.md.
  The embedded CPython and wheel distributions retain their original license
  files under resources/runtime. Exact archives and hashes are recorded in
  local-runtime/distribution.lock.json. This adds no license grant for linz.

## Deliberately not shipped（缺失组件说明）

- `not-shipped:linz-skills` — 需另行安装/替换：本包不含 linz 的第三方技能；
  如需使用须自行获取并核验相应授权。Not verified, therefore not distributed.
- `not-shipped:linz-fonts-icons` — 需另行安装/替换：本包不含 linz 字体/图标；
  当前界面图标来自随包的 @ant-design/icons npm 包。
- `not-shipped:npm-dev-dependencies` — 不随包：@types/* 等开发依赖仅在开发
  环境经 npm ci 安装，最终用户无需获取。
