import React from "react";
import clsx from "clsx";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./styles.module.css";
import Translate from "@docusaurus/Translate";

const features = [
  {
    title: <Translate id="features__title__pure_ts">Pure TypeScript</Translate>,
    imageUrl: "img/undraw_docusaurus_tree.svg",
    description: (
      <Translate id="features__desc__pure_ts">
        It consists of only Node.js standard libraries and js libraries, so it
        works as long as Node.js is installed. There is no dependency on native
        modules, so there is no need to bother with node-gyp etc... .
      </Translate>
    ),
  },
  {
    title: <Translate id="features__title__easy_to_use">Easy to Use</Translate>,
    imageUrl: "img/undraw_docusaurus_mountain.svg",
    description: (
      <Translate id="features__desc__easy_to_use">
        The API design is similar to the browser's WebRTC API, which reduces the
        learning cost.
      </Translate>
    ),
  },

  {
    title: (
      <Translate id="features__title__learn">Ideal for learning</Translate>
    ),
    imageUrl: "img/undraw_docusaurus_react.svg",
    description: (
      <Translate id="features__desc__learn">
        The code base is very small and all the protocol stacks of WebRTC are in
        one repository. It is also very easy to build, so you can easily add or
        modify features yourself.
      </Translate>
    ),
  },
];

function Feature({ imageUrl, title, description }) {
  const imgUrl = useBaseUrl(imageUrl);
  return (
    <div className={clsx("col col--4", styles.feature)}>
      {imgUrl && (
        <div className="text--center">
          <img className={styles.featureImage} src={imgUrl} alt={title} />
        </div>
      )}
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function Home() {
  const context = useDocusaurusContext();
  const { siteConfig = {} } = context;
  return (
    <Layout
      title={`Hello from ${siteConfig.title}`}
      description="Description will go into a meta tag in <head />"
    >
      <header className={clsx("hero hero--primary", styles.heroBanner)}>
        <div className="container">
          <h1 className="hero__title">{siteConfig.title}</h1>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link
              className={clsx(
                "button button--outline button--secondary button--lg",
                styles.getStarted
              )}
              to={useBaseUrl("docs/")}
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>
      <main>
        {features && features.length > 0 && (
          <section className={styles.features}>
            <div className="container">
              <div className="row">
                {features.map((props, idx) => (
                  <Feature key={idx} {...props} />
                ))}
              </div>
            </div>
          </section>
        )}
      </main>
    </Layout>
  );
}

export default Home;
