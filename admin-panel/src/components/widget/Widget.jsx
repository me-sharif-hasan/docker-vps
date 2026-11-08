import Card from '../card/Card'

export default function Widget({ icon, title, subtitle, accent = 'text-brand-500' }) {
  return (
    <Card extra="!flex-row flex-grow items-center rounded-[20px] p-3">
      <div className="ml-[8px] flex h-[70px] w-auto flex-row items-center">
        <div className="rounded-full bg-lightPrimary p-3 dark:bg-navy-700">
          <span className={`flex items-center text-2xl ${accent}`}>{icon}</span>
        </div>
      </div>
      <div className="h-50 ml-4 flex w-auto flex-col justify-center">
        <p className="font-dm text-sm font-medium text-gray-600 dark:text-gray-400">{title}</p>
        <h4 className="text-xl font-bold text-navy-700 dark:text-white">{subtitle}</h4>
      </div>
    </Card>
  )
}
