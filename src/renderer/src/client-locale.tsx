import { formatLocale, localeDirection, resolveLocale } from "@openbot/i18n";
import { TextProvider } from "@openbot/ui/text";
import type { ParentProps } from "solid-js";

export function ClientLocaleProvider(props: ParentProps) {
  const systemLocale = navigator.language;
  const locale = resolveLocale("system", systemLocale);
  const format = formatLocale("system", systemLocale);

  document.documentElement.lang = locale;
  document.documentElement.dir = localeDirection(locale);

  return (
    <TextProvider locale={locale} formatLocale={format}>
      {props.children}
    </TextProvider>
  );
}
