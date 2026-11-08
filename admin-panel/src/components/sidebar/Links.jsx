import { NavLink } from 'react-router-dom'

export default function SidebarLinks({ routes }) {
  return routes.map((route, index) => {
    const Icon = route.icon
    return (
      <NavLink key={index} to={route.path} end={route.path === '/'}>
        {({ isActive }) => (
          <div className="relative mb-3 flex hover:cursor-pointer">
            <li className="my-[3px] flex cursor-pointer items-center px-8">
              <span className={isActive ? 'font-bold text-brand-500 dark:text-white' : 'font-medium text-gray-600'}>
                <Icon className="h-6 w-6" />
              </span>
              <p className={`leading-1 ml-4 flex ${isActive ? 'font-bold text-navy-700 dark:text-white' : 'font-medium text-gray-600'}`}>
                {route.name}
              </p>
            </li>
            {isActive && <div className="absolute right-0 top-px h-9 w-1 rounded-lg bg-brand-500 dark:bg-brand-400" />}
          </div>
        )}
      </NavLink>
    )
  })
}
