import type { ReaderDocument } from '@inkwise/core';

/**
 * The article `--mock` puts on the tablet: public-domain text with plenty of
 * ff/fi ligatures, so a device test exercises the tricky highlight cases
 * without a Readwise token.
 */
export const SAMPLE_DOCUMENT: ReaderDocument = {
  id: '01inkwiseremarkabletest0000',
  url: 'https://read.readwise.io/read/01inkwiseremarkabletest0000',
  source_url: 'https://www.gutenberg.org/ebooks/1342',
  title: 'InkWise test article',
  author: 'Jane Austen',
  category: 'article',
  location: 'later',
  tags: {},
  site_name: 'InkWise',
  word_count: 420,
  reading_time: null,
  created_at: '2026-10-08T00:00:00.000000+00:00',
  updated_at: '2026-10-08T00:00:00.000000+00:00',
  published_date: null,
  content: null,
  parent_id: null,
  notes: '',
  html_content: `<p><em>This is a test from InkWise. Highlight a few passages in two colours, one across a page turn if you can, then run the sync again. Delete this article whenever you like.</em></p>
<h2>Chapter 1</h2>
<p>It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.</p>
<p>However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.</p>
<p>“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”</p>
<p>Mr. Bennet replied that he had not.</p>
<p>“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”</p>
<p>Mr. Bennet made no answer.</p>
<p>“Do not you want to know who has taken it?” cried his wife impatiently.</p>
<p>“You want to tell me, and I have no objection to hearing it.”</p>
<p>This was invitation enough.</p>
<p>“Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week.”</p>
<p>“What is his name?”</p>
<p>“Bingley.”</p>
<p>“Is he married or single?”</p>
<p>“Oh! single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!”</p>
<p>“How so? how can it affect them?”</p>
<p>“My dear Mr. Bennet,” replied his wife, “how can you be so tiresome! You must know that I am thinking of his marrying one of them.”</p>
<p>“Is that his design in settling here?”</p>
<p>“Design! nonsense, how can you talk so! But it is very likely that he may fall in love with one of them, and therefore you must visit him as soon as he comes.”</p>
<p>“I see no occasion for that. You and the girls may go, or you may send them by themselves, which perhaps will be still better; for as you are as handsome as any of them, Mr. Bingley might like you the best of the party.”</p>
<p>“My dear, you flatter me. I certainly have had my share of beauty, but I do not pretend to be any thing extraordinary now. When a woman has five grown up daughters, she ought to give over thinking of her own beauty.”</p>
<p>“In such cases, a woman has not often much beauty to think of.”</p>
<p>“But, my dear, you must indeed go and see Mr. Bingley when he comes into the neighbourhood.”</p>
<p>“It is more than I engage for, I assure you.”</p>
<p>“But consider your daughters. Only think what an establishment it would be for one of them. Sir William and Lady Lucas are determined to go, merely on that account, for in general you know they visit no new comers. Indeed you must go, for it will be impossible for us to visit him, if you do not.”</p>
<p>“You are over scrupulous surely. I dare say Mr. Bingley will be very glad to see you; and I will send a few lines by you to assure him of my hearty consent to his marrying which ever he chuses of the girls; though I must throw in a good word for my little Lizzy.”</p>
<p>“I desire you will do no such thing. Lizzy is not a bit better than the others; and I am sure she is not half so handsome as Jane, nor half so good humoured as Lydia. But you are always giving her the preference.”</p>`,
} as ReaderDocument;
