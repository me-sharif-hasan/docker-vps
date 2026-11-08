import React from 'react'
import { FiAlignJustify } from 'react-icons/fi'
import { RiMoonFill, RiSunFill } from 'react-icons/ri'
import { MdLogout } from 'react-icons/md'
import Dropdown from '../dropdown/Dropdown'
import { useAuth } from '../../context/AuthContext'

export default function Navbar({ onOpenSidenav, brandText }) {
  const [darkmode, setDarkmode] = React.useState(document.body.classList.contains('dark'))
  const { signOut } = useAuth()

  return (
    <nav className="sticky top-4 z-40 flex flex-row flex-wrap items-center justify-between rounded-xl bg-white/10 p-2 backdrop-blur-xl dark:bg-[#0b14374d]">
      <div className="ml-[6px]">
        <p className="shrink text-[28px] capitalize text-navy-700 dark:text-white">
          <span className="font-bold capitalize">{brandText}</span>
        </p>
      </div>

      <div className="relative mt-[3px] flex h-[61px] flex-grow items-center justify-end gap-3 rounded-full bg-white px-4 py-2 shadow-xl shadow-shadow-500 dark:!bg-navy-800 dark:shadow-none md:flex-grow-0">
        <span
          className="flex cursor-pointer text-xl text-gray-600 dark:text-white xl:hidden"
          onClick={onOpenSidenav}
        >
          <FiAlignJustify className="h-5 w-5" />
        </span>

        <div
          className="cursor-pointer text-gray-600"
          onClick={() => {
            document.body.classList.toggle('dark')
            setDarkmode(!darkmode)
          }}
        >
          {darkmode ? (
            <RiSunFill className="h-5 w-5 text-gray-600 dark:text-white" />
          ) : (
            <RiMoonFill className="h-5 w-5 text-gray-600 dark:text-white" />
          )}
        </div>

        <Dropdown
          button={
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-500 text-sm font-bold text-white">
              A
            </span>
          }
          children={
            <div className="flex w-56 flex-col justify-start rounded-[20px] bg-white bg-cover bg-no-repeat shadow-xl shadow-shadow-500 dark:!bg-navy-700 dark:text-white dark:shadow-none">
              <div className="p-4">
                <p className="text-sm font-bold text-navy-700 dark:text-white">Signed in as admin</p>
              </div>
              <div className="h-px w-full bg-gray-200 dark:bg-white/20" />
              <div className="flex flex-col p-4">
                <button
                  onClick={signOut}
                  className="flex items-center gap-2 text-sm font-medium text-red-500 hover:text-red-600"
                >
                  <MdLogout className="h-4 w-4" /> Sign out
                </button>
              </div>
            </div>
          }
          classNames="py-2 top-12 right-0 w-max"
        />
      </div>
    </nav>
  )
}
