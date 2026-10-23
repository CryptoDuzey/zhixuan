'use client';

import { useId, useState, type ReactNode } from 'react';

type Category = '全部' | '电脑' | '显示器' | '打印机' | '配件';
type Product = { name: string; category: Exclude<Category, '全部'>; image?: { src: string; alt: string } };

// Public display metadata copied from the existing local P1 catalog, not a live
// price/stock feed. Image IDs and versions bind the two verified local originals.
// Never import catalog.ts/facts.ts into this client component.
export const CONSULT_PRODUCTS: readonly Product[] = [
  { name: 'HUAWEI MateBook Pro S', category: '电脑', image: {
    src: '/api/image?id=7b1a7cc2d48b755d39b3af92&version=88477e9fb10790da1068abd21fafb341cb79cbd415bb0cc4129bdca3e3ed9c16',
    alt: 'MateBook Pro S 紫色机身打开时的侧面外观',
  } },
  { name: 'HUAWEI MateBook D 14 2024', category: '电脑', image: {
    src: '/api/image?id=d9fcb1ffb8e4d3f359cfe656&version=bb5dccd7a1f0c440e123a37563c56c67b8756be4dd15a330b87a8aa0d6824307',
    alt: 'MateBook D 14 打开时的正面外观，屏幕显示彩色壁纸',
  } },
  { name: 'HUAWEI MateView SE 27 英寸 QHD', category: '显示器' },
  { name: 'HUAWEI MateView GT 27 英寸高刷版', category: '显示器' },
  { name: 'HUAWEI PixLab X1', category: '打印机' },
  { name: '华为无线鼠标 3', category: '配件' },
];

const CATEGORIES: readonly Category[] = ['全部', '电脑', '显示器', '打印机', '配件'];
const QUESTIONS: Record<Category, readonly string[]> = {
  全部: ['经常出差，想选一台适合做方案的电脑。', '想给书桌配一台显示器，有哪些选择？', '知识库里有哪些产品？按类别给我看看。'],
  电脑: ['大学学习，预算 6000 左右，主要用 Office，怎么选？', '需要用 CAD 和专业插件，选电脑前该核实什么？', '想了解 MateBook Pro S，可以聊聊吗？'],
  显示器: ['主要写文档和看图，显示器怎么选？', '想了解 MateView SE 27 英寸 QHD。', 'MateView GT 27 英寸高刷版有哪些需要注意的地方？'],
  打印机: ['家里偶尔打印作业，选打印机该考虑什么？', '想了解 HUAWEI PixLab X1。', '打印、复印和扫描都有需要，有哪些选择？'],
  配件: ['想给电脑配一只鼠标，有哪些选择？', '想了解华为无线鼠标 3。', '买配件前，怎么确认和我的设备兼容？'],
};

function ProductCard({ product, disabled, onChoose }: { product: Product; disabled: boolean; onChoose: (text: string) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <button type="button" className={`consult-float-card${!product.image || imageFailed ? ' is-type-card' : ''}`}
      disabled={disabled} onClick={() => onChoose(`想了解 ${product.name}，可以介绍一下吗？`)} aria-label={`了解 ${product.name}`}>
      {product.image && !imageFailed ? <img className="consult-product-photo" src={product.image.src} alt={product.image.alt}
        width={240} height={140} loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
        : <span className="consult-product-wordmark" aria-hidden="true">{product.name.startsWith('华为') ? '华为' : 'HUAWEI'}</span>}
      <span className="consult-product-caption"><span>{product.category}</span><strong>{product.name}</strong></span>
      <span className="consult-product-arrow" aria-hidden="true">↗</span>
    </button>
  );
}

export default function ConsultProductShowcase({ children, disabled = false, onChoose }: {
  children: ReactNode; disabled?: boolean; onChoose: (text: string) => void;
}) {
  const [category, setCategory] = useState<Category>('全部');
  const [questionIndex, setQuestionIndex] = useState(0);
  const uid = useId();
  const products = CONSULT_PRODUCTS.filter(product => category === '全部' || product.category === category).slice(0, 2);
  const questions = QUESTIONS[category];
  const chooseCategory = (next: Category) => { setCategory(next); setQuestionIndex(0); };
  return (
    <div className="consult-discovery">
      <div className="consult-categories" role="tablist" aria-label="产品类别" onKeyDown={event => {
        const index = CATEGORIES.indexOf(category);
        const next = event.key === 'ArrowRight' ? (index + 1) % CATEGORIES.length
          : event.key === 'ArrowLeft' ? (index + CATEGORIES.length - 1) % CATEGORIES.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? CATEGORIES.length - 1 : -1;
        if (next < 0 || disabled) return;
        event.preventDefault();
        chooseCategory(CATEGORIES[next]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {CATEGORIES.map(item => <button key={item} type="button" role="tab" id={`${uid}-${item}`}
          aria-selected={category === item} aria-controls={`${uid}-products`} tabIndex={category === item ? 0 : -1}
          disabled={disabled} onClick={() => chooseCategory(item)}>{item}</button>)}
      </div>
      <div className="consult-product-stage" id={`${uid}-products`} role="tabpanel" aria-labelledby={`${uid}-${category}`}>
        <div className="consult-artwork" aria-hidden="true"><span /><span /></div>
        <div className="consult-floating-products">
          {products.map(product => <ProductCard key={product.name} product={product} disabled={disabled} onChoose={onChoose} />)}
        </div>
      </div>
      {children}
      <div className="consult-question-carousel" aria-label="示例问题">
        <button className="consult-question-cycle" type="button" disabled={disabled} aria-label="上一个示例问题"
          onClick={() => setQuestionIndex(index => (index + questions.length - 1) % questions.length)}>←</button>
        <div className="consult-question-current" aria-live="polite" aria-atomic="true">
          <button type="button" disabled={disabled} onClick={() => onChoose(questions[questionIndex])}>{questions[questionIndex]}<span aria-hidden="true">↗</span></button>
          <span className="consult-question-count" aria-label={`第 ${questionIndex + 1} 个，共 ${questions.length} 个示例`}>{String(questionIndex + 1).padStart(2, '0')} / {String(questions.length).padStart(2, '0')}</span>
        </div>
        <button className="consult-question-cycle" type="button" disabled={disabled} aria-label="下一个示例问题"
          onClick={() => setQuestionIndex(index => (index + 1) % questions.length)}>→</button>
      </div>
    </div>
  );
}
