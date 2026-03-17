import { motion } from "framer-motion";
import { clsx } from "clsx";

interface SectionHeadingProps {
  title: string;
  subtitle?: string;
  accentColor?: "cyan" | "purple" | "green";
  className?: string;
}

const accentMap = {
  cyan: "from-neon-cyan to-neon-cyan/0",
  purple: "from-neon-purple to-neon-purple/0",
  green: "from-neon-green to-neon-green/0",
};

const textMap = {
  cyan: "text-neon-cyan",
  purple: "text-neon-purple",
  green: "text-neon-green",
};

export default function SectionHeading({
  title,
  subtitle,
  accentColor = "cyan",
  className,
}: SectionHeadingProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.6 }}
      className={clsx("mb-12 text-center", className)}
    >
      <h2 className="text-3xl font-bold md:text-4xl">
        <span className={textMap[accentColor]}>// </span>
        {title}
      </h2>
      <div
        className={clsx(
          "mx-auto mt-4 h-px w-24 bg-gradient-to-r",
          accentMap[accentColor]
        )}
      />
      {subtitle && (
        <p className="mx-auto mt-4 max-w-2xl text-text-secondary">{subtitle}</p>
      )}
    </motion.div>
  );
}
