'use client'

import { Icon } from '../shell/Icon'
import { menuKeys, usePlacement } from '../shell/Menus'

export type MoreItem = {
  label: string
  /** The key that does the same outside the menu, printed on the item. */
  kbd?: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * A record's rarer actions behind one `⋯`: the
 * shell's popover menu, placed under its button. What you do
 * every day stays a button beside it; each item prints its key, so nothing
 * a key does is hidden. Choosing an item closes the menu first, so a
 * question it opens (`Confirm`) takes the focus.
 */
export function MoreMenu({
  id,
  label,
  items,
}: {
  /** Unique on the page: the popover's id. */
  id: string
  label: string
  items: MoreItem[]
}) {
  const ref = usePlacement(id, `[popovertarget="${id}"]`)
  return (
    <>
      <button
        type='button'
        className='iconbtn more'
        popoverTarget={id}
        aria-haspopup='menu'
        aria-label={label}
        title={label}
      >
        <Icon name='more' size={16} />
      </button>
      <div
        ref={ref}
        id={id}
        popover='auto'
        className='popover more-menu'
        role='menu'
        aria-label={label}
        onKeyDown={menuKeys}
      >
        <div className='menu-list'>
          {items.map((item) => (
            <button
              key={item.label}
              type='button'
              role='menuitem'
              className='menu-item'
              disabled={item.disabled}
              onClick={() => {
                ref.current?.hidePopover()
                item.onSelect()
              }}
            >
              <span className='label'>{item.label}</span>
              {item.kbd ? <kbd>{item.kbd}</kbd> : null}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
