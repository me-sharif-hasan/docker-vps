import { useReactTable, getCoreRowModel, getSortedRowModel, flexRender } from '@tanstack/react-table'
import { useState } from 'react'
import { MdArrowUpward, MdArrowDownward } from 'react-icons/md'

export default function DataTable({ columns, data, emptyText = 'Nothing to show yet.' }) {
  const [sorting, setSorting] = useState([])
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  })

  if (!data.length) {
    return <p className="p-4 text-sm text-gray-500 dark:text-gray-400">{emptyText}</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id} className="border-b border-gray-200 dark:border-white/10">
              {hg.headers.map(h => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  className="cursor-pointer px-3 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  <span className="flex items-center gap-1">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() === 'asc' && <MdArrowUpward className="h-3 w-3" />}
                    {h.column.getIsSorted() === 'desc' && <MdArrowDownward className="h-3 w-3" />}
                  </span>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id} className="border-b border-gray-100 dark:border-white/5">
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-3 py-3 text-sm text-navy-700 dark:text-white">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
