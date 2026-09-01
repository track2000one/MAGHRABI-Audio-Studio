import { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCcw } from 'lucide-react'

type Props = { children: ReactNode }
type State = { failed: boolean }

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] uncaught runtime error', error, info)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main className="grid min-h-screen place-items-center bg-[#070b14] px-5 text-slate-100">
        <div className="w-full max-w-lg rounded-[28px] border border-rose-300/15 bg-[#0a101c] p-7 text-center shadow-2xl shadow-black/40">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-400/10 text-rose-300">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-xl font-black">تعذر عرض هذه الأداة</h1>
          <p className="mt-3 text-sm leading-7 text-slate-400">
            حدث خطأ مؤقت داخل الواجهة. لم يتم حذف ملفك من جهازك، ويمكنك إعادة تحميل الصفحة والمحاولة مرة أخرى.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-black text-slate-950"
            >
              <RefreshCcw className="h-4 w-4" /> إعادة تحميل الصفحة
            </button>
            <a href="#" className="inline-flex items-center justify-center rounded-xl border border-white/10 px-5 py-3 text-sm font-bold text-slate-300">
              العودة للاستوديو
            </a>
          </div>
        </div>
      </main>
    )
  }
}
