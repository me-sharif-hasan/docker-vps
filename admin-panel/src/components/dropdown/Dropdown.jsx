import React, { useRef, useState, useEffect } from 'react'

function useOutsideAlerter(ref, setOpen) {
  useEffect(() => {
    function handleClickOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [ref, setOpen])
}

export default function Dropdown({ button, children, classNames = '', animation }) {
  const wrapperRef = useRef(null)
  const [open, setOpen] = useState(false)
  useOutsideAlerter(wrapperRef, setOpen)

  return (
    <div ref={wrapperRef} className="relative flex">
      <div className="flex cursor-pointer" onMouseDown={() => setOpen(!open)}>
        {button}
      </div>
      <div
        className={`${classNames} absolute z-10 ${
          animation || 'origin-top-right transition-all duration-300 ease-in-out'
        } ${open ? 'scale-100' : 'scale-0'}`}
      >
        {children}
      </div>
    </div>
  )
}
