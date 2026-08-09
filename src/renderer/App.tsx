import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppStatus,
  CategoryDetail,
  CategoryNavItem,
  CategoryRow,
  ComponentDetail,
  SectionDto,
} from '../shared/ipc.js'
import { ContextMenu, type MenuEntry, type MenuState } from './ContextMenu.js'
import { Dialog, type DialogSpec, type PickOption } from './Dialogs.js'
import { Drawer } from './Drawer.js'
import { AddComponent } from './AddComponent.js'
import { Compare } from './Compare.js'
import type { CompareResult, LeaderBoardDto } from '../shared/ipc.js'
import { Leaders } from './Leaders.js'
import { Parameters } from './Parameters.js'
import { Logo } from './Logo.js'
import { DropZone } from './DropZone.js'
import { Review } from './Review.js'
import { AiSettingsPanel } from './AiSettings.js'
import type { IngestOutcomeDto } from '../shared/ipc.js'

type SortState = { key: string; dir: 'asc' | 'desc' } | null

/** Columns the table always shows; they are not parameters and cannot be removed. */
const BUILT_IN_COLUMNS = new Set(['mpn', 'manufacturer', 'package'])
const isParameterColumn = (key: string): boolean => !key.startsWith('@') && !BUILT_IN_COLUMNS.has(key)

const LIFECYCLES = ['active', 'nrnd', 'eol', 'obsolete', 'unknown'] as const
const LIFECYCLE_LABEL: Record<(typeof LIFECYCLES)[number], string> = {
  active: 'Active', nrnd: 'Not recommended for new designs', eol: 'End of life',
  obsolete: 'Obsolete', unknown: 'Unknown',
}

/**
 * Copy without assuming a secure context.
 *
 * `navigator.clipboard` is gated on one, and a packaged build loads the
 * renderer from `file://`, where that guarantee does not hold on every
 * platform. The textarea fallback is ugly and always works.
 */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  })
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [categories, setCategories] = useState<CategoryNavItem[]>([])
  const [slug, setSlug] = useState<string | null>(null)
  const [detail, setDetail] = useState<CategoryDetail | null>(null)
  const [rows, setRows] = useState<CategoryRow[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [component, setComponent] = useState<ComponentDetail | null>(null)
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  const [compare, setCompare] = useState<CompareResult | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [board, setBoard] = useState<LeaderBoardDto | null>(null)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [review, setReview] = useState<IngestOutcomeDto | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [ingesting, setIngesting] = useState(false)
  const [pickToken, setPickToken] = useState(0)
  const [sections, setSections] = useState<SectionDto[]>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<DialogSpec | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogOpen = useRef(false)
  dialogOpen.current = dialog !== null

  const refresh = useCallback(() => {
    void window.api.status().then(setStatus)
    void window.api.listCategories().then(setCategories)
    void window.api.listSections().then(setSections)
    if (slug) {
      void window.api.categoryRows({ slug }).then(setRows)
      void window.api.categoryDetail({ slug }).then(setDetail)
      void window.api.leaders({ slug }).then(setBoard)
    }
    if (openId !== null) void window.api.componentDetail({ id: openId }).then(setComponent)
  }, [slug, openId])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 4000)
  }, [])

  useEffect(() => {
    // Dark by default; the light theme is designed, not derived.
    const stored = window.localStorage.getItem('theme')
    document.documentElement.dataset['theme'] = stored ?? 'dark'
  }, [])

  useEffect(() => {
    void window.api.status().then(setStatus)
    void window.api.listSections().then(setSections)
    void window.api.listCategories().then((list) => {
      setCategories(list)
      // The list already arrives in rail order — section order first — so the
      // first populated family in it is the one at the top of the rail.
      const first = list.find((c) => c.componentCount > 0) ?? list[0]
      if (first) setSlug(first.slug)
    })
  }, [])

  useEffect(() => {
    if (!slug) return
    setSort(null)
    setCursor(0)
    setSelected(new Set())
    void window.api.categoryDetail({ slug }).then(setDetail)
    void window.api.categoryRows({ slug }).then(setRows)
    void window.api.leaders({ slug }).then(setBoard)
  }, [slug])

  useEffect(() => {
    if (openId === null) {
      setComponent(null)
      return
    }
    void window.api.componentDetail({ id: openId }).then(setComponent)
  }, [openId])

  /**
   * The rail: every section in its stored order, then anything ungrouped.
   *
   * Built from the sections list rather than from the families, so a section
   * you just created is visible while it is still empty — otherwise there would
   * be nowhere to move the first family to.
   */
  const rail = useMemo(() => {
    const byId = new Map<number, CategoryNavItem[]>()
    const ungrouped: CategoryNavItem[] = []
    for (const c of categories) {
      if (c.sectionId === null) ungrouped.push(c)
      else byId.set(c.sectionId, [...(byId.get(c.sectionId) ?? []), c])
    }
    const out: Array<{ id: number | null; name: string; items: CategoryNavItem[] }> = sections.map(
      (s) => ({ id: s.id, name: s.name, items: byId.get(s.id) ?? [] }),
    )
    if (ungrouped.length > 0) out.push({ id: null, name: 'Ungrouped', items: ungrouped })
    return out
  }, [categories, sections])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = q
      ? rows.filter(
          (r) => r.mpn.toLowerCase().includes(q) || r.manufacturer.toLowerCase().includes(q),
        )
      : rows

    if (sort) {
      const { key, dir } = sort
      out = [...out].sort((a, b) => {
        const av = a.cells[key]
        const bv = b.cells[key]
        const an = av?.sort ?? null
        const bn = bv?.sort ?? null
        if (an !== null || bn !== null) {
          // Missing always sorts last, in both directions. An unknown value is
          // not a small value.
          if (an === null) return 1
          if (bn === null) return -1
          return dir === 'asc' ? an - bn : bn - an
        }
        const at = av?.text ?? ''
        const bt = bv?.text ?? ''
        if (!at) return 1
        if (!bt) return -1
        return dir === 'asc' ? at.localeCompare(bt) : bt.localeCompare(at)
      })
    } else {
      out = [...out].sort((a, b) => {
        if (a.rank === null && b.rank === null) return a.mpn.localeCompare(b.mpn)
        if (a.rank === null) return 1
        if (b.rank === null) return -1
        return a.rank - b.rank
      })
    }
    return out
  }, [rows, search, sort])

  // Best/worst per numeric column, for the comparison tint.
  const extremes = useMemo(() => {
    const out = new Map<string, { best: number; worst: number }>()
    for (const col of detail?.columns ?? []) {
      if (!col.numeric || col.better === 'none') continue
      const values = visible
        .map((r) => (r.cells[col.key]?.unverified ? null : r.cells[col.key]?.sort ?? null))
        .filter((v): v is number => v !== null)
      if (values.length < 2) continue
      const min = Math.min(...values)
      const max = Math.max(...values)
      if (min === max) continue
      out.set(col.key, col.better === 'lower' ? { best: min, worst: max } : { best: max, worst: min })
    }
    return out
  }, [visible, detail])

  const toggleSelected = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < 10) next.add(id)
      return next
    })
  }, [])

  const openCompare = useCallback(() => {
    const ids = [...selected]
    if (ids.length < 2) return
    void window.api.compare({ ids }).then(setCompare)
  }, [selected])

  const toggleSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }, [])

  // Keyboard: j/k walk rows with the drawer open, Enter opens, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = document.activeElement?.tagName === 'INPUT'
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'Escape') {
        if (openId !== null) setOpenId(null)
        else if (typing) (document.activeElement as HTMLElement).blur()
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.min(c + 1, visible.length - 1)
          if (openId !== null) setOpenId(visible[next]?.id ?? null)
          return next
        })
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.max(c - 1, 0)
          if (openId !== null) setOpenId(visible[next]?.id ?? null)
          return next
        })
      } else if (e.key === 'Enter') {
        const row = visible[cursor]
        if (row) setOpenId(row.id)
      } else if (e.key === ' ') {
        e.preventDefault()
        const row = visible[cursor]
        if (row) toggleSelected(row.id)
      } else if (e.key === 'c') {
        openCompare()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, cursor, openId, toggleSelected, openCompare])

  const columns = detail?.columns ?? []

  // ---------------------------------------------------------- context menus

  const closeDialog = useCallback(() => {
    setDialog(null)
    setDialogError(null)
  }, [])

  /**
   * Run something that is allowed to refuse.
   *
   * A refusal is shown inside the dialog that asked the question, or as a toast
   * when the action came straight off a menu. It is never swallowed: every
   * refusal in the taxonomy layer exists to tell you something you need to
   * know, like "40 parts are in no other family".
   */
  const run = useCallback(
    async <T extends { ok: boolean; error: string | null }>(
      work: Promise<T>,
      describe: (r: T) => string,
      after?: (r: T) => void,
    ): Promise<void> => {
      const r = await work
      if (!r.ok) {
        if (dialogOpen.current) setDialogError(r.error)
        else notify(r.error ?? 'That did not work.')
        return
      }
      closeDialog()
      refresh()
      notify(describe(r))
      after?.(r)
    },
    [closeDialog, notify, refresh],
  )

  const familyOptions = useCallback(
    (exclude?: string | null): PickOption[] =>
      categories
        .filter((c) => c.slug !== exclude)
        .map((c) => ({
          value: c.slug,
          label: c.name,
          group: c.group || 'Ungrouped',
          hint: c.componentCount > 0 ? `${c.componentCount}` : '',
        })),
    [categories],
  )

  const sectionOptions = useCallback(
    (exclude?: number | null): PickOption[] =>
      sections
        .filter((s) => s.id !== exclude)
        .map((s) => ({ value: String(s.id), label: s.name, hint: `${s.familyCount}` })),
    [sections],
  )

  // ---- sections

  const askNewSection = useCallback(() => {
    setDialogError(null)
    setDialog({
      kind: 'prompt',
      title: 'New section',
      subtitle: 'A heading in the rail — “RF PA”, “Sensors”. Families move into it.',
      label: 'Name',
      placeholder: 'RF PA',
      confirmLabel: 'Create',
      onSubmit: (name) =>
        void run(window.api.createSection({ name }), () => `Section “${name}” created.`),
    })
  }, [run])

  const askRenameSection = useCallback(
    (id: number, name: string) => {
      setDialogError(null)
      setDialog({
        kind: 'prompt',
        title: 'Rename section',
        label: 'Name',
        initial: name,
        confirmLabel: 'Rename',
        onSubmit: (next) =>
          void run(window.api.renameSection({ id, name: next }), () => `Renamed to “${next}”.`),
      })
    },
    [run],
  )

  const askDeleteSection = useCallback(
    (id: number, name: string, familyCount: number) => {
      setDialogError(null)
      if (familyCount === 0) {
        setDialog({
          kind: 'confirm',
          title: `Delete “${name}”?`,
          body: <p>The section is empty, so nothing else changes.</p>,
          confirmLabel: 'Delete section',
          danger: true,
          onSubmit: () =>
            void run(
              window.api.deleteSection({ id, reassignTo: null }),
              () => `Section “${name}” deleted.`,
            ),
        })
        return
      }
      setDialog({
        kind: 'picker',
        title: `Delete “${name}”`,
        subtitle:
          `${familyCount} ${familyCount === 1 ? 'family is' : 'families are'} in it. ` +
          'They are never deleted with the section — choose where they go.',
        options: sectionOptions(id),
        noneLabel: 'Leave them ungrouped',
        confirmLabel: 'Delete section',
        onSubmit: (value) =>
          void run(
            window.api.deleteSection({ id, reassignTo: value === null ? null : Number(value) }),
            (r) =>
              `Section deleted. ${r.movedFamilies} ${r.movedFamilies === 1 ? 'family' : 'families'} kept.`,
          ),
      })
    },
    [run, sectionOptions],
  )

  // ---- families

  const askNewFamily = useCallback(
    (sectionId: number | null, copyParametersFrom: string | null = null) => {
      setDialogError(null)
      const source = copyParametersFrom
        ? categories.find((c) => c.slug === copyParametersFrom)?.name
        : null
      setDialog({
        kind: 'prompt',
        title: source ? `Duplicate “${source}”` : 'New family',
        subtitle: source
          ? 'The parameters and ranking are copied. The parts are not — a part can be added to several families instead.'
          : 'A family is one comparison table: the parts in it are ranked against each other.',
        label: 'Name',
        placeholder: 'GNSS receiver',
        initial: source ? `${source} (copy)` : '',
        confirmLabel: 'Create',
        onSubmit: (name) =>
          void run(
            window.api.createFamily({ name, sectionId, copyParametersFrom }),
            () => `Family “${name}” created.`,
            (r) => {
              if (r.slug) setSlug(r.slug)
            },
          ),
      })
    },
    [categories, run],
  )

  const askRenameFamily = useCallback(
    (family: CategoryNavItem) => {
      setDialogError(null)
      setDialog({
        kind: 'prompt',
        title: 'Rename family',
        subtitle: family.local
          ? null
          : 'This family came from component-report. Renaming it marks it as yours, and the next import will leave it alone.',
        label: 'Name',
        initial: family.name,
        confirmLabel: 'Rename',
        onSubmit: (name) =>
          void run(
            window.api.renameFamily({ slug: family.slug, name }),
            () => `Renamed to “${name}”.`,
          ),
      })
    },
    [run],
  )

  const askDeleteFamily = useCallback(
    (family: CategoryNavItem) => {
      setDialogError(null)
      void window.api.familyImpact({ slug: family.slug }).then((impact) => {
        if (!impact) return
        const goElsewhere = (): void => {
          const remaining = categories.find((c) => c.slug !== family.slug)
          if (family.slug === slug) setSlug(remaining?.slug ?? null)
        }
        if (impact.orphanCount === 0) {
          setDialog({
            kind: 'confirm',
            title: `Delete “${impact.name}”?`,
            body: (
              <>
                <p>
                  {impact.componentCount === 0
                    ? 'No parts are in it.'
                    : `${impact.componentCount} ${impact.componentCount === 1 ? 'part is' : 'parts are'} in it, and every one of them is also in another family, so no part is lost.`}
                </p>
                {impact.parameterCount > 0 && (
                  <p className="hint">
                    Its {impact.parameterCount} parameter
                    {impact.parameterCount === 1 ? '' : 's'} and the values recorded against them go
                    too. Values on other families are untouched.
                  </p>
                )}
                <p className="hint">
                  It stays deleted when the import runs again, rather than coming back.
                </p>
              </>
            ),
            confirmLabel: 'Delete family',
            danger: true,
            onSubmit: () =>
              void run(
                window.api.deleteFamily({ slug: family.slug, reassignTo: null }),
                () => `Family “${impact.name}” deleted.`,
                goElsewhere,
              ),
          })
          return
        }
        setDialog({
          kind: 'picker',
          title: `Delete “${impact.name}”`,
          subtitle:
            `${impact.orphanCount} of its ${impact.componentCount} parts ` +
            `${impact.orphanCount === 1 ? 'is' : 'are'} in no other family. ` +
            'Choose where the parts go — they are moved first, then the family is deleted.',
          options: familyOptions(family.slug),
          confirmLabel: 'Move and delete',
          onSubmit: (value) => {
            if (!value) return
            void run(
              window.api.deleteFamily({ slug: family.slug, reassignTo: value }),
              (r) => `${r.movedComponents} parts moved, family deleted.`,
              goElsewhere,
            )
          },
        })
      })
    },
    [categories, familyOptions, run, slug],
  )

  const sectionSubmenu = useCallback(
    (family: CategoryNavItem): MenuEntry[] => [
      ...sections.map((s) => ({
        id: `to-section-${s.id}`,
        label: s.name,
        checked: s.id === family.sectionId,
        onSelect: () =>
          void run(
            window.api.setFamilySection({ slug: family.slug, sectionId: s.id }),
            () => `“${family.name}” moved to ${s.name}.`,
          ),
      })),
      { id: 'sec-sep', separator: true },
      {
        id: 'to-none',
        label: 'Ungrouped',
        checked: family.sectionId === null,
        onSelect: () =>
          void run(
            window.api.setFamilySection({ slug: family.slug, sectionId: null }),
            () => `“${family.name}” is now ungrouped.`,
          ),
      },
      { id: 'sec-sep2', separator: true },
      { id: 'to-new', label: 'New section…', onSelect: askNewSection },
    ],
    [askNewSection, run, sections],
  )

  const openMenu = useCallback((e: React.MouseEvent, state: Omit<MenuState, 'x' | 'y'>) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, ...state })
  }, [])

  const sectionMenu = useCallback(
    (e: React.MouseEvent, section: { id: number | null; name: string; count: number }) => {
      const real = section.id !== null
      const index = sections.findIndex((s) => s.id === section.id)
      const ungroupedReason = 'Ungrouped is where families with no section land — it is not a section itself.'
      openMenu(e, {
        title: section.name,
        items: [
          {
            id: 'new-family',
            label: 'New family here…',
            onSelect: () => askNewFamily(section.id),
          },
          {
            id: 'rename',
            label: 'Rename section…',
            disabled: !real,
            reason: ungroupedReason,
            onSelect: () => real && askRenameSection(section.id!, section.name),
          },
          { id: 'sep1', separator: true },
          {
            id: 'up',
            label: 'Move section up',
            disabled: !real || index <= 0,
            reason: real ? 'Already at the top.' : ungroupedReason,
            onSelect: () =>
              real &&
              void run(window.api.moveSection({ id: section.id!, direction: 'up' }), () => 'Moved up.'),
          },
          {
            id: 'down',
            label: 'Move section down',
            disabled: !real || index === sections.length - 1,
            reason: real ? 'Already at the bottom.' : ungroupedReason,
            onSelect: () =>
              real &&
              void run(window.api.moveSection({ id: section.id!, direction: 'down' }), () => 'Moved down.'),
          },
          { id: 'sep2', separator: true },
          { id: 'new-section', label: 'New section…', onSelect: askNewSection },
          { id: 'sep3', separator: true },
          {
            id: 'delete',
            label: 'Delete section…',
            danger: true,
            disabled: !real,
            reason: ungroupedReason,
            hint: section.count > 0 ? `${section.count} families kept` : undefined,
            onSelect: () => real && askDeleteSection(section.id!, section.name, section.count),
          },
        ],
      })
    },
    [askDeleteSection, askNewFamily, askNewSection, askRenameSection, openMenu, run, sections],
  )

  const familyMenu = useCallback(
    (e: React.MouseEvent, family: CategoryNavItem) => {
      openMenu(e, {
        title: family.name,
        items: [
          { id: 'open', label: 'Open', onSelect: () => setSlug(family.slug) },
          { id: 'rename', label: 'Rename family…', onSelect: () => askRenameFamily(family) },
          { id: 'move', label: 'Move to section', submenu: sectionSubmenu(family) },
          { id: 'sep1', separator: true },
          {
            id: 'params',
            label: 'Parameters…',
            onSelect: () => {
              setSlug(family.slug)
              setParamsOpen(true)
            },
          },
          {
            id: 'duplicate',
            label: 'Duplicate parameters into a new family…',
            onSelect: () => askNewFamily(family.sectionId, family.slug),
          },
          {
            id: 'export',
            label: 'Export as CSV',
            onSelect: () =>
              void window.api.exportCsv({ slug: family.slug }).then((r) => {
                if (r.ok) notify(`Exported ${r.bytes.toLocaleString()} bytes to ${r.path}`)
              }),
          },
          { id: 'sep2', separator: true },
          { id: 'new-family', label: 'New family…', onSelect: () => askNewFamily(family.sectionId) },
          { id: 'sep3', separator: true },
          {
            id: 'delete',
            label: 'Delete family…',
            danger: true,
            hint: family.componentCount > 0 ? `${family.componentCount} parts` : undefined,
            onSelect: () => askDeleteFamily(family),
          },
        ],
      })
    },
    [askDeleteFamily, askNewFamily, askRenameFamily, notify, openMenu, sectionSubmenu],
  )

  const rowMenu = useCallback(
    (e: React.MouseEvent, row: CategoryRow) => {
      // Right-clicking inside a multi-selection acts on the whole selection;
      // right-clicking outside it acts on the row under the cursor, and leaves
      // the selection alone.
      const useSelection = selected.has(row.id) && selected.size > 1
      const ids = useSelection ? [...selected] : [row.id]
      const n = ids.length
      const many = n > 1
      const subject = many ? `${n} parts` : row.mpn
      const mpns = visible.filter((r) => ids.includes(r.id)).map((r) => r.mpn)

      const moveTo = (mode: 'move' | 'add'): void => {
        setDialogError(null)
        setDialog({
          kind: 'picker',
          title: mode === 'move' ? `Move ${subject}` : `Also add ${subject} to…`,
          subtitle:
            mode === 'move'
              ? `Taken out of ${detail?.name ?? 'this family'} and put in the family you choose.`
              : 'A part can be in several families at once — this adds a membership without removing any.',
          options: familyOptions(mode === 'move' ? slug : null),
          confirmLabel: mode === 'move' ? 'Move' : 'Add',
          onSubmit: (value) => {
            if (!value) return
            void run(
              window.api.setComponentFamily({
                ids, toSlug: value, mode, fromSlug: mode === 'move' ? slug : null,
              }),
              (r) =>
                mode === 'move'
                  ? `${r.moved} moved.`
                  : `${r.moved} added${r.alreadyThere > 0 ? `, ${r.alreadyThere} already there` : ''}.`,
              () => setSelected(new Set()),
            )
          },
        })
      }

      openMenu(e, {
        title: subject,
        items: [
          {
            id: 'open',
            label: 'Open details',
            disabled: many,
            reason: 'Opens one part at a time.',
            onSelect: () => setOpenId(row.id),
          },
          {
            id: 'copy-mpn',
            label: many ? `Copy ${n} part numbers` : 'Copy part number',
            onSelect: () => {
              copyText(mpns.join('\n'))
              notify(many ? `${n} part numbers copied.` : `${row.mpn} copied.`)
            },
          },
          {
            id: 'copy-row',
            label: many ? `Copy ${n} rows` : 'Copy row',
            hint: 'tab separated',
            onSelect: () => {
              const header = columns.map((c) => c.label).join('\t')
              const body = visible
                .filter((r) => ids.includes(r.id))
                .map((r) => columns.map((c) => r.cells[c.key]?.text ?? '').join('\t'))
                .join('\n')
              copyText(`${header}\n${body}`)
              notify(`${n} ${n === 1 ? 'row' : 'rows'} copied.`)
            },
          },
          { id: 'sep1', separator: true, label: 'Family' },
          { id: 'move', label: 'Move to family…', onSelect: () => moveTo('move') },
          { id: 'add', label: 'Also add to family…', onSelect: () => moveTo('add') },
          {
            id: 'remove',
            label: `Remove from ${detail?.name ?? 'this family'}`,
            onSelect: () =>
              void run(
                window.api.removeFromFamily({ ids, slug: slug ?? '' }),
                (r) => `${r.removed} removed from ${detail?.name ?? 'the family'}.`,
                () => setSelected(new Set()),
              ),
          },
          { id: 'sep2', separator: true },
          {
            id: 'lifecycle',
            label: 'Set lifecycle',
            submenu: LIFECYCLES.map((l) => ({
              id: `lc-${l}`,
              label: LIFECYCLE_LABEL[l],
              checked: !many && row.lifecycle === l,
              onSelect: () =>
                void window.api.setLifecycle({ ids, lifecycle: l }).then((count) => {
                  refresh()
                  notify(`${count} set to ${LIFECYCLE_LABEL[l].toLowerCase()}.`)
                }),
            })),
          },
          {
            id: 'select',
            label: selected.has(row.id) ? 'Deselect' : 'Select for comparison',
            disabled: !selected.has(row.id) && selected.size >= 10,
            reason: 'Ten parts is the most the comparison shows at once.',
            onSelect: () => toggleSelected(row.id),
          },
          {
            id: 'compare',
            label: `Compare ${selected.size} selected`,
            disabled: selected.size < 2,
            reason: 'Select at least two parts.',
            onSelect: openCompare,
          },
          { id: 'sep3', separator: true },
          {
            id: 'delete',
            label: many ? `Delete ${n} parts…` : 'Delete part…',
            danger: true,
            onSelect: () => {
              setDialogError(null)
              setDialog({
                kind: 'confirm',
                title: many ? `Delete ${n} parts?` : `Delete ${row.mpn}?`,
                body: (
                  <>
                    <p>
                      {many ? 'These parts' : 'This part'} leave{many ? '' : 's'} every family, along
                      with {many ? 'their' : 'its'} package, values, solution profiles and stored
                      datasheets.
                    </p>
                    <p className="hint">This cannot be undone from inside the app.</p>
                  </>
                ),
                confirmLabel: many ? `Delete ${n} parts` : 'Delete part',
                danger: true,
                onSubmit: () =>
                  void window.api.deleteComponents({ ids }).then((count) => {
                    closeDialog()
                    setSelected(new Set())
                    setOpenId(null)
                    refresh()
                    notify(`${count} ${count === 1 ? 'part' : 'parts'} deleted.`)
                  }),
              })
            },
          },
        ],
      })
    },
    [
      closeDialog, columns, detail, familyOptions, notify, openCompare, openMenu, refresh, run,
      selected, slug, toggleSelected, visible,
    ],
  )

  const columnMenu = useCallback(
    (e: React.MouseEvent, col: { key: string; label: string }) => {
      const parameter = isParameterColumn(col.key)
      const builtIn = 'Built-in columns are not parameters; they come from the part itself.'
      openMenu(e, {
        title: col.label,
        items: [
          {
            id: 'asc',
            label: 'Sort ascending',
            checked: sort?.key === col.key && sort.dir === 'asc',
            onSelect: () => setSort({ key: col.key, dir: 'asc' }),
          },
          {
            id: 'desc',
            label: 'Sort descending',
            checked: sort?.key === col.key && sort.dir === 'desc',
            onSelect: () => setSort({ key: col.key, dir: 'desc' }),
          },
          {
            id: 'clear',
            label: 'Clear sort',
            disabled: sort === null,
            reason: 'Nothing is sorted.',
            onSelect: () => setSort(null),
          },
          { id: 'sep1', separator: true, label: 'Parameter' },
          {
            id: 'hide',
            label: 'Hide this column',
            disabled: !parameter,
            reason: builtIn,
            onSelect: () =>
              void run(
                window.api.updateSpecDef({
                  slug: slug ?? '', key: col.key, patch: { tableVisible: false },
                }),
                () => `“${col.label}” hidden. Add it back from Parameters.`,
              ),
          },
          {
            id: 'edit',
            label: 'Edit parameters…',
            onSelect: () => setParamsOpen(true),
          },
          {
            id: 'remove',
            label: 'Remove this parameter…',
            danger: true,
            disabled: !parameter,
            reason: builtIn,
            onSelect: () => {
              setDialogError(null)
              setDialog({
                kind: 'confirm',
                title: `Remove “${col.label}”?`,
                body: (
                  <>
                    <p>The parameter and every value recorded against it in this family are removed.</p>
                    <p className="hint">
                      It stays removed when the import runs again, rather than reappearing.
                    </p>
                  </>
                ),
                confirmLabel: 'Remove parameter',
                danger: true,
                onSubmit: () =>
                  void run(
                    window.api.removeSpecDef({ slug: slug ?? '', key: col.key }),
                    () => `“${col.label}” removed.`,
                  ),
              })
            },
          },
        ],
      })
    },
    [openMenu, run, slug, sort],
  )

  return (
    <div className="app">
      <div className="brand">
        <span className="brand-logo" aria-hidden><Logo size={19} /></span>
        <span>Component Library</span>
      </div>

      <div className="topbar">
        <div className="search-box">
          <span aria-hidden>⌕</span>
          <input
            ref={searchRef}
            value={search}
            placeholder="Filter this family by part number or manufacturer…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="kbd">Ctrl K</span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
          + Add<span className="label-long"> component</span>
        </button>
        <button
          className="btn"
          disabled={!slug}
          title="Export this family as CSV"
          onClick={() => {
            if (!slug) return
            void window.api.exportCsv({ slug }).then((r) => {
              if (r.ok) notify(`Exported ${r.bytes.toLocaleString()} bytes to ${r.path}`)
            })
          }}
        >
          <span className="label-long">Export </span>CSV
        </button>
        <button
          className="btn"
          title="Back up the whole database as JSON"
          onClick={() => {
            void window.api.exportJson().then((r) => {
              if (r.ok) notify(`Backed up ${r.bytes.toLocaleString()} bytes to ${r.path}`)
            })
          }}
        >
          <span className="label-long">Back up</span>
          <span className="label-short">⤓</span>
        </button>
        <button
          className="btn"
          onClick={() => setAiOpen(true)}
          title="Choose the model used to read datasheets"
        >
          ⚙
        </button>
        <button
          className="btn"
          onClick={() => {
            const root = document.documentElement
            const next = root.dataset['theme'] === 'light' ? 'dark' : 'light'
            root.dataset['theme'] = next
            window.localStorage.setItem('theme', next)
          }}
          title="Toggle theme"
        >
          ◐
        </button>
      </div>

      <nav
        className="sidebar"
        onContextMenu={(e) =>
          openMenu(e, {
            title: 'Library',
            items: [
              { id: 'new-family', label: 'New family…', onSelect: () => askNewFamily(null) },
              { id: 'new-section', label: 'New section…', onSelect: askNewSection },
            ],
          })
        }
      >
        {rail.map((section) => (
          <div key={section.id ?? 'ungrouped'}>
            <div
              className="nav-group"
              onContextMenu={(e) =>
                sectionMenu(e, { id: section.id, name: section.name, count: section.items.length })
              }
              title="Right-click to rename, reorder or delete this section"
            >
              {section.name}
            </div>
            {section.items.map((c) => (
              <button
                key={c.slug}
                className="nav-item"
                aria-current={c.slug === slug}
                onClick={() => setSlug(c.slug)}
                onContextMenu={(e) => familyMenu(e, c)}
                title={c.name}
              >
                <span className="nav-item-label">{c.name}</span>
                <span className="count">{c.componentCount}</span>
              </button>
            ))}
            {section.items.length === 0 && (
              <div className="nav-empty">Empty — right-click to add a family</div>
            )}
          </div>
        ))}
      </nav>

      <main className="main">
        {detail && (
          <header className="cat-header">
            <div style={{ minWidth: 0 }}>
              <div className="cat-title">{detail.name}</div>
              <div className="cat-metric">
                Ranked by: <b>{detail.metricProse || 'not defined'}</b>
              </div>
              {detail.requirements.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {detail.requirements.map((r) => (
                    <span key={r} className="chip chip-warn" title="Parts failing this are shown but not ranked">
                      Hard requirement: {r}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
              <span className="chip">{visible.length} parts</span>
              {selected.size > 0 && <span className="chip">{selected.size} selected</span>}
              <button
                className="btn"
                onClick={() => setParamsOpen(true)}
                title="Add, edit or remove this family's parameters"
              >
                Parameters
              </button>
              <button
                className="btn btn-primary"
                disabled={selected.size < 2}
                title={selected.size < 2 ? 'Select at least two parts' : 'Compare selection'}
                onClick={openCompare}
              >
                Compare
              </button>
            </div>
          </header>
        )}

        <Leaders
          board={board}
          onOpen={(id) => setOpenId(id)}
          onMenu={(e, leader) =>
            openMenu(e, {
              title: `${leader.better === 'lower' ? 'Lowest' : 'Highest'} ${leader.label}`,
              items: [
                { id: 'open', label: `Open ${leader.mpn}`, onSelect: () => setOpenId(leader.componentId) },
                {
                  id: 'copy',
                  label: 'Copy part number',
                  onSelect: () => {
                    copyText(leader.mpn)
                    notify(`${leader.mpn} copied.`)
                  },
                },
                { id: 'sep', separator: true },
                {
                  id: 'sort',
                  label: `Sort the table by ${leader.label}`,
                  hint: leader.better === 'lower' ? 'best first' : 'best first',
                  onSelect: () =>
                    setSort({ key: leader.key, dir: leader.better === 'lower' ? 'asc' : 'desc' }),
                },
                {
                  id: 'why',
                  label: 'Why this one?',
                  onSelect: () =>
                    notify(
                      `Best of ${leader.contenders} part${leader.contenders === 1 ? '' : 's'} ` +
                        `holding a confirmed value` +
                        (leader.skippedUnverified > 0
                          ? `; ${leader.skippedUnverified} excluded as unverified`
                          : '') +
                        (leader.tied ? `; tied with ${leader.tiedWith} other` : '') + '.',
                    ),
                },
              ],
            })
          }
        />

        <div className="table-scroll">
          {visible.length === 0 ? (
            <div className="empty">
              <h3>No parts in this family yet</h3>
              <div>Drop a datasheet anywhere, or right-click a part elsewhere to move it here.</div>
            </div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th style={{ width: 46 }} className="num">#</th>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={col.numeric ? 'num' : ''}
                      onClick={() => toggleSort(col.key)}
                      onContextMenu={(e) => columnMenu(e, col)}
                      title={`Sort by ${col.label} · right-click for more`}
                    >
                      {col.label}
                      {col.unit && <span className="unit"> ({col.unit})</span>}
                      {sort?.key === col.key && (
                        <span className="sort">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => (
                  <tr
                    key={row.id}
                    aria-selected={i === cursor}
                    className={row.failedRequirements.length > 0 ? 'excluded' : ''}
                    onClick={() => {
                      setCursor(i)
                      setOpenId(row.id)
                    }}
                    onContextMenu={(e) => {
                      setCursor(i)
                      rowMenu(e, row)
                    }}
                    title={row.unrankedReason ?? undefined}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        title="Select for comparison"
                      />
                    </td>
                    <td className="num">
                      <span
                        className={`rank ${
                          row.rank === null ? 'rank-none'
                          : row.rank === 1 ? 'rank-1'
                          : row.rank === 2 ? 'rank-2'
                          : row.rank === 3 ? 'rank-3'
                          : 'rank-n'
                        }`}
                        title={row.unrankedReason ?? `Rank ${row.rank} in this family`}
                      >
                        {row.rank === null ? '—' : row.rank}
                      </span>
                    </td>
                    {columns.map((col) => {
                      const cell = row.cells[col.key]
                      const ext = extremes.get(col.key)
                      const v = cell?.unverified ? null : cell?.sort ?? null
                      const tint =
                        ext && v !== null ? (v === ext.best ? ' best' : v === ext.worst ? ' worst' : '') : ''
                      const isMpn = col.key === 'mpn'
                      return (
                        <td key={col.key} className={col.numeric ? `num${tint}` : tint.trim()}>
                          {cell?.text ? (
                            <span
                              className={
                                (cell.unverified ? 'unverified ' : '') + (isMpn ? 'mpn' : '')
                              }
                              title={
                                cell.unverified
                                  ? 'Imported from a report summary — not confirmed against a datasheet, and excluded from ranking.'
                                  : undefined
                              }
                            >
                              {isMpn && (
                                <span
                                  className={`lifecycle-dot${row.lifecycle === 'active' ? ' lifecycle-active' : ''}`}
                                />
                              )}
                              {cell.text}
                            </span>
                          ) : (
                            <span className="missing">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="statusbar">
          <span>{status?.componentCount ?? 0} components</span>
          <span>{status?.categoryCount ?? 0} families</span>
          {status && status.dataQuality.unverifiedDimensions > 0 && (
            <span title="Dimensions parsed from report prose, awaiting confirmation">
              {status.dataQuality.unverifiedDimensions} unverified dimensions
            </span>
          )}
          {status && status.dataQuality.missingDimensions > 0 && (
            <span>{status.dataQuality.missingDimensions} missing dimensions</span>
          )}
          <span style={{ flex: 1 }} />
          {status?.warnings.map((w) => (
            <span key={w} style={{ color: 'var(--warn)' }}>{w}</span>
          ))}
        </div>
      </main>

      <Drawer
        component={component}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        onChanged={refresh}
      />

      <AddComponent
        open={addOpen}
        categories={categories}
        initialCategory={slug}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          refresh()
          notify('Component saved.')
        }}
        onPickPdf={() => setPickToken((n) => n + 1)}
      />

      <Compare result={compare} onClose={() => setCompare(null)} />

      <Parameters
        open={paramsOpen}
        slug={slug}
        categoryName={detail?.name ?? ''}
        onClose={() => setParamsOpen(false)}
        onChanged={refresh}
      />

      <DropZone
        pickToken={pickToken}
        onStart={() => setIngesting(true)}
        onDone={(outcome) => {
          setIngesting(false)
          setReview(outcome)
        }}
        onError={(m) => {
          setIngesting(false)
          notify(m)
        }}
      />

      <Review
        outcome={review}
        categories={categories}
        busy={ingesting}
        onClose={() => {
          if (review) void window.api.discardReview({ jobId: review.jobId })
          setReview(null)
        }}
        onSaved={(id) => {
          setReview(null)
          refresh()
          setOpenId(id)
          notify('Component saved from datasheet.')
        }}
      />

      <AiSettingsPanel open={aiOpen} onClose={() => setAiOpen(false)} onChanged={refresh} />

      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <Dialog spec={dialog} error={dialogError} onClose={closeDialog} />

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
